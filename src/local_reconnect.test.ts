const { localConnector } = require("../roborockLib/lib/localConnector");

function createConnector() {
  const getParameter = jest.fn();
  const adapter = {
    log: { debug: jest.fn() },
    localDevices: { "vacuum-1": "192.0.2.1" },
    hasInitializedVacuum: jest.fn().mockReturnValue(true),
    vacuums: { "vacuum-1": { getParameter } },
  };
  const connector = new localConnector(adapter);
  return { adapter, connector, getParameter };
}

describe("DHCP-aware local reconnect", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-02T00:00:00Z") });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("refreshes the address through cloud with a per-device rate limit", async () => {
    const { adapter, connector, getParameter } = createConnector();
    getParameter.mockImplementation(async () => {
      adapter.localDevices["vacuum-1"] = "192.0.2.2";
    });

    expect(await connector.refreshLocalIp("vacuum-1")).toBe("192.0.2.2");
    expect(await connector.refreshLocalIp("vacuum-1")).toBe("192.0.2.2");
    expect(getParameter).toHaveBeenCalledTimes(1);
    expect(getParameter).toHaveBeenCalledWith("vacuum-1", "get_network_info");

    await jest.advanceTimersByTimeAsync(60000);
    await connector.refreshLocalIp("vacuum-1");
    expect(getParameter).toHaveBeenCalledTimes(2);
  });

  it("reconnects once using the refreshed address", async () => {
    const { adapter, connector, getParameter } = createConnector();
    getParameter.mockImplementation(async () => {
      adapter.localDevices["vacuum-1"] = "192.0.2.2";
    });
    const connect = jest.spyOn(connector, "createClient").mockResolvedValue();
    connector.scheduleReconnect("vacuum-1", "192.0.2.1");
    connector.scheduleReconnect("vacuum-1", "192.0.2.1");

    await jest.advanceTimersByTimeAsync(60000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("vacuum-1", "192.0.2.2");
    expect(connector.reconnectTimeouts.size).toBe(0);
  });

  it("cancels reconnect and address refresh when shutting down", async () => {
    const { connector, getParameter } = createConnector();
    const connect = jest.spyOn(connector, "createClient").mockResolvedValue();
    connector.scheduleReconnect("vacuum-1", "192.0.2.1");
    connector.shutdown();
    connector.scheduleReconnect("vacuum-1", "192.0.2.1");

    await jest.advanceTimersByTimeAsync(120000);

    expect(connect).not.toHaveBeenCalled();
    expect(getParameter).not.toHaveBeenCalled();
    expect(connector.reconnectTimeouts.size).toBe(0);
  });
});
