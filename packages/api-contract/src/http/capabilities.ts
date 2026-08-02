import { z } from 'zod';

/**
 * The connected Rocket.Chat server's settings and the caller's permissions.
 *
 * Clients gate features on this rather than on their own assumptions: whether
 * editing is allowed, for how long, whether uploads are on and which types are
 * accepted are all administrator choices, and a client that ignores them shows
 * buttons that fail when pressed.
 *
 * Only the settings a client can act on are exposed. The full public settings
 * list runs to hundreds of entries, most of them server-side concerns.
 */
export const ServerSettingsSchema = z.object({
  siteName: z.string(),

  message: z.object({
    allowEditing: z.boolean(),
    /** Minutes after posting during which an edit is still allowed. 0 = forever. */
    blockEditInMinutes: z.number().int().min(0),
    allowDeleting: z.boolean(),
    blockDeleteInMinutes: z.number().int().min(0),
    allowPinning: z.boolean(),
    allowStarring: z.boolean(),
    /** Character limit for a single message. */
    maxAllowedSize: z.number().int().min(1),
    /**
     * Whether a message over `maxAllowedSize` may be offered as a `.txt`
     * upload instead of being refused outright.
     */
    allowConvertLongMessagesToAttachment: z.boolean(),
    /** Seconds within which consecutive messages from one author are grouped. */
    groupingPeriodSeconds: z.number().int().min(0),
    showEditedStatus: z.boolean(),
    /** When on, deleted messages leave a visible tombstone instead of vanishing. */
    showDeletedStatus: z.boolean(),
    /** Server-configured time formats, in Moment.js notation. */
    timeFormat: z.string(),
    timeAndDateFormat: z.string(),
  }),

  threads: z.object({
    enabled: z.boolean(),
  }),

  fileUpload: z.object({
    enabled: z.boolean(),
    /** Whether uploads are allowed specifically in direct messages. */
    enabledDirect: z.boolean(),
    maxFileSizeBytes: z.number().int(),
    /** Empty means "any type"; otherwise only these are accepted. */
    acceptedMediaTypes: z.array(z.string()),
    /** Always rejected, even when the allow list is empty. */
    blockedMediaTypes: z.array(z.string()),
  }),

  ui: z.object({
    /** Show `name` rather than `username` throughout. */
    useRealName: z.boolean(),
    /**
     * When on, Rocket.Chat slugifies a room name before validating it, so
     * spaces and punctuation are accepted and a client should not pre-validate.
     */
    allowSpecialCharsInRoomNames: z.boolean(),
    /**
     * `UTF8_Channel_Names_Validation`, the body of the pattern a room name must
     * match — anchors excluded, exactly as Rocket.Chat stores it. Defaults to
     * ASCII, which is why an accented name fails until an administrator widens
     * it. Only meaningful when `allowSpecialCharsInRoomNames` is off.
     */
    roomNameValidationPattern: z.string(),
    /** Whether users may mark rooms as favourites. */
    favoriteRooms: z.boolean(),
  }),

  presence: z.object({
    /** The server disabled user-controlled presence broadcasting. */
    broadcastDisabled: z.boolean(),
  }),

  encryption: z.object({
    /** End-to-end encryption is available; rooms may opt in. */
    enabled: z.boolean(),
  }),

  accounts: z.object({
    allowProfileChange: z.boolean(),
    allowAvatarChange: z.boolean(),
    allowStatusMessageChange: z.boolean(),
  }),
});
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

/**
 * Permission ids mapped to the roles that hold them, plus the caller's own
 * roles — the same model Rocket.Chat evaluates against. A permission is held
 * when its role list intersects the user's global roles or their roles in the
 * room being acted on.
 */
export const PermissionsSchema = z.object({
  /** `{ 'edit-message': ['owner', 'moderator', 'admin'] }` */
  rolesByPermission: z.record(z.string(), z.array(z.string())),
  /** The caller's server-wide roles. Room roles come from the room itself. */
  userRoles: z.array(z.string()),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

/** `GET /api/v1/server/capabilities` */
export const ServerCapabilitiesSchema = z.object({
  settings: ServerSettingsSchema,
  permissions: PermissionsSchema,
});
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
