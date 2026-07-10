import { StrictMode } from "react";
import { EventEmitter } from "eventemitter3";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionMachine } from "../connection-machine";
import { ParcaeProvider } from "../react/Provider";
import { SessionMachine } from "../session-machine";

const clientFactory = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../client", () => ({ createClient: clientFactory.create }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeClient extends EventEmitter {
  session = new SessionMachine();
  connection = new ConnectionMachine();
  dispose = vi.fn(() => this.emit("dispose"));
}

describe("owned ParcaeProvider", () => {
  const clients: FakeClient[] = [];
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    clients.length = 0;
    clientFactory.create.mockReset();
    clientFactory.create.mockImplementation(() => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
  });

  it("disposes every client created by StrictMode effect replay", async () => {
    await act(async () => {
      renderer = create(
        <StrictMode>
          <ParcaeProvider url="http://localhost:3000">
            <div />
          </ParcaeProvider>
        </StrictMode>,
      );
    });

    expect(clients).toHaveLength(2);
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(clients[1]!.dispose).not.toHaveBeenCalled();

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(clients.every((client) => client.dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("creates an independent live client after unmount", async () => {
    await act(async () => {
      renderer = create(
        <ParcaeProvider url="http://localhost:3000">
          <div />
        </ParcaeProvider>,
      );
    });
    const first = clients[0]!;

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(first.dispose).toHaveBeenCalledOnce();

    await act(async () => {
      renderer = create(
        <ParcaeProvider url="http://localhost:3000">
          <div />
        </ParcaeProvider>,
      );
    });
    const second = clients[1]!;

    expect(second).not.toBe(first);
    expect(second.dispose).not.toHaveBeenCalled();
  });
});
