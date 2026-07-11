const { vacuum: Vacuum } = require("../roborockLib/lib/vacuum");

describe("Roborock empty room mapping warning", () => {
  it("warns once until a valid room mapping is received", async () => {
    let mappedRooms: unknown[] = [];
    const log = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    };
    const adapter = {
      createStateObjectHelper: jest.fn().mockResolvedValue(undefined),
      log,
      messageQueueHandler: {
        sendRequest: jest.fn(
          (_duid: string, method: string): Promise<unknown> =>
            Promise.resolve(
              method === "get_status" ? [{ map_status: 0 }] : mappedRooms
            )
        ),
      },
      roomIDs: { 16: "Kitchen" },
      segmentRoomNames: {},
    };
    const vacuum = new Vacuum(adapter, "roborock.vacuum.a168");

    await vacuum.getParameter("vacuum-1", "get_room_mapping");
    await vacuum.getParameter("vacuum-1", "get_room_mapping");

    expect(log.warn).toHaveBeenCalledTimes(1);

    mappedRooms = [[1, 16]];
    await vacuum.getParameter("vacuum-1", "get_room_mapping");

    mappedRooms = [];
    await vacuum.getParameter("vacuum-1", "get_room_mapping");

    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
