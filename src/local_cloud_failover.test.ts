import { Socket } from "net";

const { Roborock } = require("../roborockLib/roborockAPI");

function createRoborock() {
  const log = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const roborock = new Roborock({ log });
  roborock.states.HomeData = {
    val: JSON.stringify({
      devices: [{ duid: "vacuum-1", online: true }],
      receivedDevices: [],
    }),
  };

  return { log, roborock };
}

describe("Roborock local transport failover", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("marks an unresponsive local device as cloud-only for the session", async () => {
    const { log, roborock } = createRoborock();

    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalTimeout("vacuum-1");

    expect(await roborock.isRemoteDevice("vacuum-1")).toBe(false);

    roborock.recordLocalTimeout("vacuum-1");

    expect(await roborock.isRemoteDevice("vacuum-1")).toBe(true);
    expect(roborock.shouldPreferCloudLocally("vacuum-1")).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "Local connection for vacuum-1 is unresponsive after 3 consecutive timeouts; using cloud for the rest of this plugin session."
    );

    roborock.recordLocalTimeout("vacuum-1");
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("clears the timeout streak after a successful local response", async () => {
    const { roborock } = createRoborock();

    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalSuccess("vacuum-1");
    roborock.recordLocalTimeout("vacuum-1");

    expect(await roborock.isRemoteDevice("vacuum-1")).toBe(false);
  });

  it("retests local transport in a new plugin session", async () => {
    const firstSession = createRoborock().roborock;
    firstSession.recordLocalTimeout("vacuum-1");
    firstSession.recordLocalTimeout("vacuum-1");
    firstSession.recordLocalTimeout("vacuum-1");

    const nextSession = createRoborock().roborock;

    expect(await firstSession.isRemoteDevice("vacuum-1")).toBe(true);
    expect(await nextSession.isRemoteDevice("vacuum-1")).toBe(false);
  });

  it.each([false, true])(
    "keeps an unresponsive device on cloud after TCP reconnect (temporary fallback: %s)",
    async (temporaryFallback) => {
      const { log, roborock } = createRoborock();
      roborock.recordLocalTimeout("vacuum-1");
      roborock.recordLocalTimeout("vacuum-1");
      roborock.recordLocalTimeout("vacuum-1");
      if (temporaryFallback) {
        roborock.remoteDevices.add("vacuum-1");
      }
      mockTcpConnect(roborock.localConnector);
      log.info.mockClear();

      try {
        await roborock.localConnector.createClient("vacuum-1", "192.0.2.1");

        expect(roborock.localConnector.isConnected("vacuum-1")).toBe(true);
        expect(await roborock.isRemoteDevice("vacuum-1")).toBe(true);
        expect(roborock.shouldPreferCloudLocally("vacuum-1")).toBe(true);
        expect(roborock.remoteDevices.has("vacuum-1")).toBe(false);
        expect(log.info).not.toHaveBeenCalled();
      } finally {
        roborock.localConnector.shutdown();
      }
    }
  );

  it("returns to local transport after a temporary TCP failure recovers", async () => {
    const { log, roborock } = createRoborock();
    roborock.remoteDevices.add("vacuum-1");
    mockTcpConnect(roborock.localConnector);

    try {
      await roborock.localConnector.createClient("vacuum-1", "192.0.2.2");

      expect(await roborock.isRemoteDevice("vacuum-1")).toBe(false);
      expect(roborock.shouldPreferCloudLocally("vacuum-1")).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        "Local connection for vacuum-1 restored. Switching back from cloud to local mode."
      );
    } finally {
      roborock.localConnector.shutdown();
    }
  });

  it("does not clear session failover on a late reply or elapsed time", async () => {
    const { roborock } = createRoborock();
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalTimeout("vacuum-1");
    roborock.recordLocalSuccess("vacuum-1");
    jest.mocked(Date.now).mockReturnValue(now + 60 * 60 * 1000);

    expect(await roborock.isRemoteDevice("vacuum-1")).toBe(true);
    expect(roborock.shouldPreferCloudLocally("vacuum-1")).toBe(true);
    expect(await roborock.isRemoteDevice("vacuum-2")).toBe(false);
  });

  it("routes real queue requests through cloud after local timeouts and reconnect", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
    const { roborock } = createRoborock();
    const connector = roborock.localConnector;
    mockTcpConnect(connector);
    jest.spyOn(roborock, "getRobotVersion").mockResolvedValue("1.0");
    jest.spyOn(roborock.rr_mqtt_connector, "isConnected").mockReturnValue(true);
    jest.spyOn(roborock.message, "buildPayload").mockResolvedValue("payload");
    jest
      .spyOn(roborock.message, "buildRoborockMessage")
      .mockResolvedValue(Buffer.from("request"));
    const localSend = jest.spyOn(connector, "sendMessage").mockImplementation();
    const cloudSend = jest
      .spyOn(roborock.rr_mqtt_connector, "sendMessage")
      .mockImplementation(() => {
        for (const [id, request] of roborock.pendingRequests) {
          roborock.clearTimeout(request.timeout);
          roborock.pendingRequests.delete(id);
          request.resolve(["ok"]);
        }
      });

    try {
      await connector.createClient("vacuum-1", "192.0.2.1");
      for (let attempt = 0; attempt < 3; attempt++) {
        const request = roborock.messageQueueHandler.sendRequest(
          "vacuum-1",
          "get_status",
          []
        );
        const timedOut = expect(request).rejects.toThrow("Local request");
        await jest.advanceTimersByTimeAsync(10000);
        await timedOut;
      }

      connector.localClients["vacuum-1"].destroy();
      await jest.advanceTimersByTimeAsync(0);
      roborock.remoteDevices.add("vacuum-1");
      await connector.createClient("vacuum-1", "192.0.2.2");

      await expect(
        roborock.messageQueueHandler.sendRequest("vacuum-1", "get_status", [])
      ).resolves.toEqual(["ok"]);
      expect(localSend).toHaveBeenCalledTimes(3);
      expect(cloudSend).toHaveBeenCalledTimes(1);
      expect(await roborock.isRemoteDevice("vacuum-1")).toBe(true);
      expect(roborock.pendingRequests.size).toBe(0);
    } finally {
      connector.shutdown();
    }
  });
});

function mockTcpConnect(connector: {
  ensureL01Handshake: (duid: string) => Promise<boolean>;
}) {
  jest.spyOn(connector, "ensureL01Handshake").mockResolvedValue(true);
  jest.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    const onConnect = args[args.length - 1] as () => void;
    queueMicrotask(() => {
      this.emit("connect");
      onConnect();
    });
    return this;
  });
}
