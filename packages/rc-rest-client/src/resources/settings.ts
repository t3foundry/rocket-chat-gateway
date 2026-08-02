import { AuthenticatedResource } from './base.js';

export interface RcSetting {
  _id: string;
  value?: unknown;
}

export interface RcPermission {
  _id: string;
  roles?: string[];
}

/** Shared by the authenticated and anonymous readers of `settings.public`. */
export const toSettingsMap = (settings: RcSetting[] | undefined): Map<string, unknown> =>
  new Map((settings ?? []).map((setting) => [setting._id, setting.value]));

export class SettingsResource extends AuthenticatedResource {
  /**
   * Public settings, as a lookup keyed by id.
   *
   * Rocket.Chat returns hundreds of entries and offers no way to ask for a
   * subset without a Mongo-style `query`, which differs across versions — so
   * the whole list is fetched and the gateway picks what it needs. It is
   * cached there, not requested per page load.
   */
  async publicSettings(): Promise<Map<string, unknown>> {
    const response = await this.get<{ settings?: RcSetting[] }>('settings.public', { count: 0 });
    return toSettingsMap(response.settings);
  }

  /**
   * Every permission with the roles that hold it. This is the same data
   * Rocket.Chat's own client evaluates against, so gating computed from it
   * matches what the server will actually allow.
   */
  async permissions(): Promise<RcPermission[]> {
    const response = await this.get<{ update?: RcPermission[] } | RcPermission[]>('permissions.listAll');
    if (Array.isArray(response)) return response;
    return response.update ?? [];
  }
}
