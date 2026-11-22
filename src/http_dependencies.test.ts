import { createHash, createHmac } from "crypto";

const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { fetchDevices } = require("../roborockLib/lib/roborockHome");

const loginOptions = {
  baseURL: "https://euiot.roborock.com/",
  username: "test@example.com",
  clientID: "test-client",
  language: "de",
};

function mockRequests(respond: (request: Request) => unknown) {
  const requests: Request[] = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    return Response.json(respond(request));
  });
  return requests;
}

describe("Roborock HTTP dependency compatibility", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(["code", "password"])(
    "preserves %s login form serialization and authentication headers",
    async (method) => {
      const timeout = jest.spyOn(AbortSignal, "timeout");
      const requests = mockRequests((request) => {
        if (new URL(request.url).pathname === "/api/v3/app/agreement/latest") {
          return {
            code: 200,
            data: { majorVersion: 16, minorVersion: 1 },
          };
        }
        return { code: 200, data: { token: "test-token" } };
      });
      const api = roborockAuth.createLoginApi(loginOptions);
      const credentials = {
        email: loginOptions.username,
        password: "test-password",
        code: "123456",
        country: "DE",
        countryCode: "49",
        k: "0123456789abcdef",
        s: "test-signature",
      };
      const result =
        method === "code"
          ? await roborockAuth.loginWithCode(api, credentials)
          : await roborockAuth.loginByPassword(api, credentials);

      expect(result).toEqual({ code: 200, data: { token: "test-token" } });
      expect(requests).toHaveLength(2);
      const agreementRequest = requests[0];
      expect(agreementRequest.url).toBe(
        "https://euiot.roborock.com/api/v3/app/agreement/latest?country=DE"
      );
      expect(agreementRequest.headers.get("header_clientlang")).toBe("en");

      const request = requests[1];
      expect(request.url).toBe(
        `https://euiot.roborock.com/api/v4/auth/email/login/${method === "code" ? "code" : "pwd"}`
      );
      expect(timeout.mock.calls).toEqual([[20000], [20000]]);
      expect(request.headers.get("Content-Type")).toBe(
        "application/x-www-form-urlencoded"
      );
      expect(request.headers.get("header_clientlang")).toBe("de");
      expect(request.headers.get("header_clientid")).toBe(
        createHash("md5")
          .update(loginOptions.username + loginOptions.clientID)
          .digest("base64")
      );
      expect(request.headers.get("x-mercy-k")).toBe(credentials.k);
      expect(request.headers.get("x-mercy-ks")).toBe(credentials.s);
      const form = new URLSearchParams(await request.text());
      expect(form.get("email")).toBe(credentials.email);
      expect(form.get("majorVersion")).toBe("16");
      expect(form.get("minorVersion")).toBe("1");
      if (method === "code") {
        expect(form.get("code")).toBe(credentials.code);
        expect(form.get("countryCode")).toBe("49");
      } else {
        expect(form.get("password")).toBeTruthy();
        expect(form.get("password")).not.toBe(credentials.password);
      }
    }
  );

  it("retains token headers, Hawk signing and JSON responses for device discovery", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const rriot = {
      u: "test-user",
      s: "test-session",
      h: "test-signing-key",
      r: { a: "https://api.example.test/" },
    };
    const requests = mockRequests((request) => {
      if (new URL(request.url).pathname === "/api/v1/getHomeDetail") {
        return { data: { rrHomeId: "test-home" } };
      }
      return {
        result: {
          products: [{ id: "product-1", model: "roborock.vacuum.a168" }],
          devices: [
            { duid: "vacuum-1", name: "Robot", productId: "product-1" },
          ],
          receivedDevices: [],
        },
      };
    });

    await expect(
      fetchDevices({
        ...loginOptions,
        userData: { token: "test-token", rriot },
      })
    ).resolves.toEqual([
      {
        duid: "vacuum-1",
        name: "Robot",
        model: "roborock.vacuum.a168",
        shared: false,
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get("Authorization")).toBe("test-token");
    const signedRequest = requests[1];
    expect(signedRequest.url).toBe(
      "https://api.example.test/v2/user/homes/test-home"
    );
    expect(timeout.mock.calls).toEqual([[20000], [20000]]);
    const authorization = String(signedRequest.headers.get("Authorization"));
    expect(authorization).toMatch(/^Hawk /);
    const fields = Object.fromEntries(
      Array.from(authorization.matchAll(/(\w+)="([^"]*)"/g), (m) => [
        m[1],
        m[2],
      ])
    );
    expect(fields.id).toBe(rriot.u);
    expect(fields.s).toBe(rriot.s);
    const pathHash = createHash("md5")
      .update("/v2/user/homes/test-home")
      .digest("hex");
    const signedContent = [
      rriot.u,
      rriot.s,
      fields.nonce,
      fields.ts,
      pathHash,
      "",
      "",
    ].join(":");
    expect(fields.mac).toBe(
      createHmac("sha256", rriot.h).update(signedContent).digest("base64")
    );
  });

  it("propagates transport failures without treating them as a login response", async () => {
    const error = new Error("connection closed");
    jest.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const api = roborockAuth.createLoginApi(loginOptions);

    await expect(
      roborockAuth.loginWithCode(api, {
        email: loginOptions.username,
        code: "123456",
        country: "DE",
        countryCode: "49",
        k: "0123456789abcdef",
        s: "test-signature",
      })
    ).rejects.toMatchObject({ isRequestError: true, cause: error });
  });
});
