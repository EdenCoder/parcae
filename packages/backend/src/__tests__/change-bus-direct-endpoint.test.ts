import { describe, expect, it } from 'vitest';
import { directEndpointFor } from '../services/change-bus';

describe('directEndpointFor', () => {
  it('drops the pooler suffix from a Neon host', () => {
    expect(
      directEndpointFor(
        'postgres://u:p@ep-cool-name-123-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require',
      ),
    ).toBe(
      'postgres://u:p@ep-cool-name-123.ap-southeast-2.aws.neon.tech/db?sslmode=require',
    );
  });

  it('leaves a host that is already direct alone', () => {
    expect(
      directEndpointFor('postgres://u:p@ep-cool-name-123.aws.neon.tech/db'),
    ).toBeNull();
    expect(directEndpointFor('postgres://postgres@localhost:5432/freia')).toBeNull();
  });

  it('returns null rather than throwing on an unparseable url', () => {
    expect(directEndpointFor('not a url')).toBeNull();
  });
});
