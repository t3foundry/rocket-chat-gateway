import { isAvatarMediaType } from '@t3foundry/open-rocket-chat-api-contract';
import { describe, expect, it, vi } from 'vitest';

import { toDataUri, withSettledAvatarTag } from '../common/avatar';

describe('isAvatarMediaType', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])('accepts %s', (type) => {
    expect(isAvatarMediaType(type)).toBe(true);
  });

  it('ignores parameters browsers append to the type', () => {
    expect(isAvatarMediaType('image/png; charset=binary')).toBe(true);
  });

  it.each(['image/tiff', 'image/pic', 'application/pdf', 'text/plain', '', undefined])('rejects %s', (type) => {
    expect(isAvatarMediaType(type)).toBe(false);
  });
});

describe('toDataUri', () => {
  it('encodes the image the way Rocket.Chat expects a room avatar', () => {
    const uri = toDataUri({ filename: 'a.png', contentType: 'image/png', content: Buffer.from('hi') });
    expect(uri).toBe('data:image/png;base64,aGk=');
  });
});

describe('withSettledAvatarTag', () => {
  /** Only the field the helper watches; both upstream records carry it. */
  interface Tagged {
    avatarETag?: string;
  }

  const reader = () => vi.fn<() => Promise<Tagged>>();

  it('returns the first read once the tag has already moved on', async () => {
    const read = reader().mockResolvedValue({ avatarETag: 'new' });

    const settled = await withSettledAvatarTag(read, (value) => value.avatarETag, 'old');

    expect(settled).toEqual({ avatarETag: 'new' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads until Rocket.Chat has written the new tag', async () => {
    vi.useFakeTimers();

    const read = reader()
      .mockResolvedValueOnce({ avatarETag: 'old' })
      .mockResolvedValueOnce({ avatarETag: 'old' })
      .mockResolvedValue({ avatarETag: 'new' });

    const pending = withSettledAvatarTag(read, (value) => value.avatarETag, 'old');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ avatarETag: 'new' });
    expect(read).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('gives up rather than failing when the tag never changes', async () => {
    vi.useFakeTimers();

    const read = reader().mockResolvedValue({ avatarETag: 'old' });

    const pending = withSettledAvatarTag(read, (value) => value.avatarETag, 'old');
    await vi.runAllTimersAsync();

    // A stale tag is a worse answer than a fresh one and a far better answer
    // than an error for an upload that did in fact succeed.
    await expect(pending).resolves.toEqual({ avatarETag: 'old' });
    expect(read).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });
});
