import { RocketChatApiError } from '../errors.js';
import type { RcListEnvelope, RcUser } from '../types.js';
import { AuthenticatedResource, copyBytes } from './base.js';

export class UsersResource extends AuthenticatedResource {
  /** The authenticated user's own record, including preferences and roles. */
  async me(): Promise<RcUser> {
    return this.get<RcUser>('me');
  }

  async info(params: { userId?: string; username?: string }): Promise<RcUser> {
    const response = await this.get<{ user: RcUser }>('users.info', {
      userId: params.userId,
      username: params.username,
    });
    return response.user;
  }

  /**
   * Interactive people search, for mention autocomplete and member pickers.
   *
   * `spotlight` rather than the more obviously named `users.autocomplete`.
   * Both answer the same question, but they differ in how they behave for a
   * caller who lacks `view-outside-room` — the permission large public servers
   * revoke so that members cannot enumerate the whole user base. Denied that,
   * `users.autocomplete` falls back to an aggregation that fans out over every
   * room the caller belongs to and every subscription of those rooms; one
   * hundred-thousand-member channel is enough for it never to answer inside a
   * request timeout. Spotlight's equivalent fallback is bounded to the caller's
   * direct messages and reads from a replica, so it stays interactive at any
   * server size.
   *
   * The result count is the server's `Number_of_users_autocomplete_suggestions`
   * rather than a number this client picks.
   */
  async search(term: string): Promise<RcUser[]> {
    try {
      const response = await this.get<{ users?: RcUser[] }>('spotlight', {
        query: term,
        // Rooms are a separate search on the same route; asking for them here
        // would be work thrown away.
        type: JSON.stringify({ users: true, rooms: false }),
      });
      return response.users ?? [];
    } catch (error) {
      // Servers too old to expose spotlight over REST, or strict enough about
      // its parameters to reject the ones above, still have the older route.
      if (error instanceof RocketChatApiError && (error.status === 404 || error.status === 400)) {
        return this.autocomplete(term);
      }
      throw error;
    }
  }

  /**
   * The older search route, kept as the fallback for `search`.
   * `users.autocomplete` expects its filter wrapped in a JSON `selector`,
   * unlike every other search route in the API.
   */
  async autocomplete(term: string): Promise<RcUser[]> {
    const response = await this.get<{ items?: RcUser[] }>('users.autocomplete', {
      selector: JSON.stringify({ term }),
    });
    return response.items ?? [];
  }

  async listByStatus(offset: number, count: number): Promise<{ users: RcUser[]; total: number }> {
    const response = await this.get<RcListEnvelope<'users', RcUser>>('users.list', { offset, count });
    return { users: response.users ?? [], total: response.total ?? 0 };
  }

  /** Presence for a set of users; cheaper than `users.info` per user. */
  async presence(userIds: string[]): Promise<{ _id: string; status?: string; statusText?: string }[]> {
    const response = await this.get<{ users?: { _id: string; status?: string; statusText?: string }[] }>(
      'users.presence',
      { ids: userIds.join(',') },
    );
    return response.users ?? [];
  }

  /**
   * Sets the caller's presence and/or status message.
   *
   * Each field is only sent when the caller asked for it: Rocket.Chat treats a
   * present `message` as an instruction to overwrite the text — including with
   * an empty string, which is how the message gets cleared — so passing it
   * unconditionally would wipe a status the caller never mentioned.
   */
  async setStatus(input: { status?: string; message?: string }): Promise<void> {
    await this.post('users.setStatus', {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.message === undefined ? {} : { message: input.message }),
    });
  }

  /**
   * Replaces the caller's avatar with an uploaded image.
   *
   * The field is `image` rather than `file`, and the route is one of the few
   * that reads a multipart body outside the upload API.
   */
  async setAvatar(input: { filename: string; contentType: string; content: Uint8Array }): Promise<void> {
    const form = new FormData();
    form.set('image', new Blob([copyBytes(input.content)], { type: input.contentType }), input.filename);

    await this.http.request('users.setAvatar', {
      method: 'POST',
      formData: form,
      credentials: this.credentials,
    });
  }

  /**
   * Drops the stored picture so Rocket.Chat serves generated initials again.
   *
   * `userId` is required even for oneself: the route resolves its target from
   * the body and refuses a request that names nobody.
   */
  async resetAvatar(userId: string): Promise<void> {
    await this.post('users.resetAvatar', { userId });
  }

  async logout(): Promise<void> {
    await this.post('logout');
  }
}
