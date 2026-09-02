import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { createHash, createHmac } from "crypto";

const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { fetchDevices } = require("../roborockLib/lib/roborockHome");

const originalAdapter = axios.defaults.adapter;
const loginOptions = {
  baseURL: "https://euiot.roborock.com/",
  username: "test@example.com",
  clientID: "test-client",
  language: "de",
};

function jsonResponse(config: InternalAxiosRequestConfig, data: unknown) {
  return {
    config,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    data: JSON.stringify(data),
  };
}

describe("Roborock HTTP dependency compatibility", () => {
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it.each(["code", "password"])(
    "preserves %s login form serialization and authentication headers",
    async (method) => {
      const requests: InternalAxiosRequestConfig[] = [];
      axios.defaults.adapter = async (config) => {
        requests.push(config);
        return jsonResponse(config, {
          code: 200,
          data: { token: "test-token" },
        });
      };
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
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(axios.getUri(request)).toBe(
        `https://euiot.roborock.com/api/v4/auth/email/login/${method === "code" ? "code" : "pwd"}`
      );
      expect(request.timeout).toBe(20000);
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
      const form = new URLSearchParams(request.data);
      expect(form.get("email")).toBe(credentials.email);
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
    const requests: InternalAxiosRequestConfig[] = [];
    const rriot = {
      u: "test-user",
      s: "test-session",
      h: "test-signing-key",
      r: { a: "https://api.example.test/" },
    };
    axios.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url === "api/v1/getHomeDetail") {
        return jsonResponse(config, { data: { rrHomeId: "test-home" } });
      }
      return jsonResponse(config, {
        result: {
          products: [{ id: "product-1", model: "roborock.vacuum.a168" }],
          devices: [
            { duid: "vacuum-1", name: "Robot", productId: "product-1" },
          ],
          receivedDevices: [],
        },
      });
    };

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
    expect(axios.getUri(signedRequest)).toBe(
      "https://api.example.test/v2/user/homes/test-home"
    );
    expect(signedRequest.timeout).toBe(20000);
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
    const error = new AxiosError("timeout", AxiosError.ECONNABORTED);
    axios.defaults.adapter = async () => {
      throw error;
    };
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
    ).rejects.toBe(error);
  });
});
