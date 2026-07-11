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
});
