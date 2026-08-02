import type { ServerCapabilities, ServerSettings } from '@open-rocket-chat/api-contract';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import type { ServerSession } from '../session/session.types';

/**
 * How long a server's settings and permission map are reused.
 *
 * Permission changes affect which controls may be used, so this remains short
 * enough for role updates to reach clients promptly without fetching several
 * hundred records on every render.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  capabilities: Omit<ServerCapabilities, 'permissions'> & {
    permissions: { rolesByPermission: Record<string, string[]> };
  };
  expiresAt: number;
}

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : typeof value === 'string' ? value === 'true' : fallback;

const asNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

/** Rocket.Chat stores media type lists as a comma-separated string. */
const asMediaTypes = (value: unknown): string[] =>
  asString(value, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

@Injectable()
export class CapabilitiesService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly rocketChat: RocketChatService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CapabilitiesService.name);
  }

  async get(session: ServerSession): Promise<ServerCapabilities> {
    const shared = await this.serverCapabilities(session);

    return {
      settings: shared.settings,
      permissions: {
        rolesByPermission: shared.permissions.rolesByPermission,
        // Roles are per-user, so only this part is read fresh.
        userRoles: await this.userRoles(session),
      },
    };
  }

  private async serverCapabilities(session: ServerSession): Promise<CacheEntry['capabilities']> {
    const cached = this.cache.get(session.serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities;

    const client = this.rocketChat.userClient(session);

    try {
      const [settings, permissions] = await Promise.all([
        client.settings.publicSettings(),
        client.settings.permissions(),
      ]);

      const capabilities = {
        settings: this.toSettings(settings),
        permissions: {
          // App-provided slash commands may name arbitrary permissions, so a
          // hard-coded subset can never cover the UI. Rocket.Chat's own client
          // consumes this same full permission map.
          rolesByPermission: Object.fromEntries(
            permissions.map((permission) => [permission._id, permission.roles ?? []]),
          ),
        },
      };

      this.cache.set(session.serverId, { capabilities, expiresAt: Date.now() + CACHE_TTL_MS });
      return capabilities;
    } catch (error) {
      this.logger.warn({ err: error, serverId: session.serverId }, 'could not read server capabilities');
      // An expired, real answer is safer than inventing permissive defaults for
      // a server whose administrator may have disabled uploads or editing.
      if (cached) return cached.capabilities;
      throw toApiException(error);
    }
  }

  private async userRoles(session: ServerSession): Promise<string[]> {
    try {
      const me = await this.rocketChat.userClient(session).users.me();
      return me.roles ?? [];
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Defaults mirror Rocket.Chat's own, so a setting the server does not report
   * behaves the way that server behaves.
   */
  private toSettings(values: Map<string, unknown>): ServerSettings {
    return {
      siteName: asString(values.get('Site_Name'), 'Rocket.Chat'),

      message: {
        allowEditing: asBoolean(values.get('Message_AllowEditing'), true),
        blockEditInMinutes: asNumber(values.get('Message_AllowEditing_BlockEditInMinutes'), 0),
        allowDeleting: asBoolean(values.get('Message_AllowDeleting'), true),
        blockDeleteInMinutes: asNumber(values.get('Message_AllowDeleting_BlockDeleteInMinutes'), 0),
        allowPinning: asBoolean(values.get('Message_AllowPinning'), true),
        allowStarring: asBoolean(values.get('Message_AllowStarring'), true),
        maxAllowedSize: asNumber(values.get('Message_MaxAllowedSize'), 5000),
        allowConvertLongMessagesToAttachment: asBoolean(
          values.get('Message_AllowConvertLongMessagesToAttachment'),
          true,
        ),
        groupingPeriodSeconds: asNumber(values.get('Message_GroupingPeriod'), 300),
        showEditedStatus: asBoolean(values.get('Message_ShowEditedStatus'), true),
        showDeletedStatus: asBoolean(values.get('Message_ShowDeletedStatus'), false),
        timeFormat: asString(values.get('Message_TimeFormat'), 'LT'),
        timeAndDateFormat: asString(values.get('Message_TimeAndDateFormat'), 'LLL'),
      },

      threads: { enabled: asBoolean(values.get('Threads_enabled'), true) },

      fileUpload: {
        enabled: asBoolean(values.get('FileUpload_Enabled'), true),
        enabledDirect: asBoolean(values.get('FileUpload_Enabled_Direct'), true),
        maxFileSizeBytes: asNumber(values.get('FileUpload_MaxFileSize'), 104_857_600),
        acceptedMediaTypes: asMediaTypes(values.get('FileUpload_MediaTypeWhiteList')),
        blockedMediaTypes: asMediaTypes(values.get('FileUpload_MediaTypeBlackList')),
      },

      ui: {
        useRealName: asBoolean(values.get('UI_Use_Real_Name'), false),
        allowSpecialCharsInRoomNames: asBoolean(values.get('UI_Allow_room_names_with_special_chars'), false),
        roomNameValidationPattern: asString(values.get('UTF8_Channel_Names_Validation'), '[0-9a-zA-Z-_.]+'),
        favoriteRooms: asBoolean(values.get('Favorite_Rooms'), true),
      },

      presence: {
        broadcastDisabled: asBoolean(values.get('Presence_broadcast_disabled'), false),
      },

      encryption: { enabled: asBoolean(values.get('E2E_Enable'), false) },

      accounts: {
        allowProfileChange: asBoolean(values.get('Accounts_AllowUserProfileChange'), true),
        allowAvatarChange: asBoolean(values.get('Accounts_AllowUserAvatarChange'), true),
        allowStatusMessageChange: asBoolean(values.get('Accounts_AllowUserStatusMessageChange'), true),
      },
    };
  }
}
