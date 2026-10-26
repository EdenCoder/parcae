import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthClient } from 'better-auth/react';
import { betterAuth } from '../client.js';

type Session = { data: { session: { token: string } } | null; isPending: boolean };

/** Better Auth's `session` atom, which the app's `useSession` shares. */
function sessionAtom(initial: Session) {
  let value = initial;
  const listeners = new Set<(value: Session) => void>();
  const session = {
    get: () => value,
    listen(listener: (value: Session) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client: { $store: { atoms: { session } } } as unknown as ReturnType<typeof createAuthClient>,
    set(next: Session) {
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
  };
}

const PENDING: Session = { data: null, isPending: true };
const ANONYMOUS: Session = { data: null, isPending: false };
const signedIn = (token: string): Session => ({ data: { session: { token } }, isPending: false });

describe('betterAuth client', () => {
  beforeEach(() => {
    // The adapter watches only in a browser.
    vi.stubGlobal('window', {});
  });

  it('hands the hello the first settled read', async () => {
    const atom = sessionAtom(PENDING);
    const adapter = betterAuth({ client: atom.client });
    const token = adapter.getToken();
    atom.set(signedIn('abc'));
    expect(await token).toBe('abc');
    expect(await adapter.getToken()).toBe('abc');
  });

  it('reports sign-in and sign-out, never the baseline or an anonymous re-read', () => {
    const atom = sessionAtom(PENDING);
    const adapter = betterAuth({ client: atom.client });
    const callback = vi.fn();
    adapter.onChange(callback);

    atom.set(ANONYMOUS);
    // An anonymous focus re-read goes pending again; firing `null` here
    // would terminate the Parcae session and blank every mounted query.
    atom.set(PENDING);
    atom.set(ANONYMOUS);
    expect(callback).not.toHaveBeenCalled();

    atom.set(signedIn('abc'));
    atom.set(ANONYMOUS);
    expect(callback.mock.calls).toEqual([['abc'], [null]]);
  });

  it('stops reporting after unsubscribe', () => {
    const atom = sessionAtom(signedIn('abc'));
    const adapter = betterAuth({ client: atom.client });
    const callback = vi.fn();
    const unsubscribe = adapter.onChange(callback);
    unsubscribe();
    atom.set(ANONYMOUS);
    expect(callback).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
