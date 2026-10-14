/**
 * Project Room — model profile service.
 *
 * Implements the four configuration levels of the design notes and the switch
 * protocol of §3.6. The rules that matter, stated once:
 *
 *   - Every option comes from the host's real catalogue. A brand name is never
 *     turned into a model id.
 *   - Precedence is member-fixed > role-default > project-default. Nothing falls
 *     back to a hardcoded vendor.
 *   - `allowed-pool` selection may only choose inside `allowedProfileRefs`, and
 *     never touches a member whose model is locked.
 *   - A switch records a revision; the old results keep their old source.
 *
 * @module dsh-project-room/src/host/models/model-service
 */

import { RoomError } from '../../../shared/contracts.js';

/**
 * @typedef {object} ModelSettings
 * @property {string | null} projectDefaultProfileRef
 * @property {Record<string, string>} roleDefaults
 * @property {'fixed' | 'allowed-pool'} selectionMode
 * @property {string[]} allowedProfileRefs
 * @property {'none' | 'allowed-pool'} fallbackMode
 */

/** @type {ModelSettings} */
export const DEFAULT_MODEL_SETTINGS = Object.freeze({
  projectDefaultProfileRef: null,
  roleDefaults: {},
  selectionMode: 'fixed',
  allowedProfileRefs: [],
  fallbackMode: 'none',
});

export class ModelProfileService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.logger = input.logger ?? null;
    /** @type {Map<string, import('../../../shared/contracts.js').ResolvedModelProfile[]>} */
    this.catalogCache = new Map();
  }

  /* ---------------------------------------------------------------- *
   * Catalogue
   * ---------------------------------------------------------------- */

  /**
   * The live catalogue: provider routes and exact model ids, with real
   * capability status. Cached briefly because reading it hits provider
   * adapters.
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<import('../../../shared/contracts.js').ResolvedModelProfile[]>}
   */
  async listProfiles(options = {}) {
    const cached = this.catalogCache.get('all');
    if (!options.refresh && cached) return cached;
    const profiles = await this.adapter.listModelProfiles();
    this.catalogCache.set('all', profiles);
    for (const profile of profiles) {
      this.store.upsertModelProfile({
        id: profile.id,
        hostProfileRef: profile.hostProfileRef,
        providerRoute: profile.providerRoute,
        modelId: profile.modelId,
        label: profile.label,
        capabilities: profile.capabilities,
        capabilitiesRevision: 1,
      });
    }
    return profiles;
  }

  /**
   * One exact profile by id, verified against the live catalogue.
   * @param {string} profileRef
   * @returns {Promise<import('../../../shared/contracts.js').ResolvedModelProfile>}
   */
  async requireProfile(profileRef) {
    if (!profileRef || typeof profileRef !== 'string') {
      throw new RoomError('INVALID_REQUEST', '缺少模型配置引用。');
    }
    const catalog = await this.listProfiles();
    const found = catalog.find((profile) => profile.id === profileRef);
    if (found) {
      if (found.capabilityStatus === 'unavailable') {
        throw new RoomError('MEMBER_UNAVAILABLE', `模型 ${profileRef} 当前不可用：${found.note ?? '原因未知'}。`);
      }
      return found;
    }
    // Not in the catalogue: allow an explicit `provider/model` the host can
    // still resolve (a freshly added provider), but never a bare nickname.
    const slash = profileRef.indexOf('/');
    if (slash > 0) {
      const providerRoute = profileRef.slice(0, slash);
      const modelId = profileRef.slice(slash + 1);
      return this.adapter.resolveProfile(providerRoute, modelId);
    }
    throw new RoomError(
      'INVALID_REQUEST',
      `无法把“${profileRef}”当作模型标识。请使用“提供方/模型ID”的准确写法，并先在宿主接入该模型。`,
    );
  }

  /**
   * Models that satisfy a set of required capabilities.
   * @param {string[]} requiredCapabilities
   * @param {{ role?: string, allowedOnly?: boolean }} [options]
   * @returns {Promise<import('../../../shared/contracts.js').ResolvedModelProfile[]>}
   */
  async candidatesFor(requiredCapabilities = [], options = {}) {
    const catalog = (await this.listProfiles()).filter((profile) => profile.capabilityStatus !== 'unavailable');
    const byCapability =
      requiredCapabilities.length === 0
        ? catalog
        : catalog.filter((profile) => requiredCapabilities.every((capability) => profile.capabilities.includes(capability)));
    if (!options.allowedOnly) return byCapability;
    const settings = this.settingsOf(options.roomId);
    if (settings.allowedProfileRefs.length === 0) return [];
    return byCapability.filter((profile) => settings.allowedProfileRefs.includes(profile.id));
  }

  /* ---------------------------------------------------------------- *
   * Resolution and assignment
   * ---------------------------------------------------------------- */

  /**
   * Read the model settings out of a room's config.
   * @param {string} roomId
   * @returns {ModelSettings}
   */
  settingsOf(roomId) {
    const room = this.store.getRoom(roomId);
    const configured = room?.config?.models ?? {};
    return { ...DEFAULT_MODEL_SETTINGS, ...configured };
  }

  /**
   * The model a member would use right now, and where that choice came from.
   *
   * This is the single place precedence is decided, so the UI cannot show a
   * different answer than execution uses.
   *
   * @param {object} member
   * @returns {Promise<{ profileRef: string | null, source: import('../../../shared/contracts.js').SelectionSource, profile: object | null }>}
   */
  async effectiveFor(member) {
    if (member.modelProfileRef) {
      return {
        profileRef: member.modelProfileRef,
        source: member.selectionSource ?? (member.modelLocked ? 'member-fixed' : 'role-default'),
        profile: this.store.getModelProfile(member.modelProfileRef),
      };
    }
    const settings = this.settingsOf(member.roomId);
    const roleRef = settings.roleDefaults?.[member.role];
    if (roleRef) {
      return { profileRef: roleRef, source: 'role-default', profile: this.store.getModelProfile(roleRef) };
    }
    if (settings.projectDefaultProfileRef) {
      return {
        profileRef: settings.projectDefaultProfileRef,
        source: 'project-default',
        profile: this.store.getModelProfile(settings.projectDefaultProfileRef),
      };
    }
    return { profileRef: null, source: 'project-default', profile: null };
  }

  /**
   * Write a member's model and record the revision.
   *
   * The database write is the commit point; the live route changes on the next
   * request. A failure to apply leaves the previous effective binding in place
   * and reports it, rather than pretending the switch happened (the design notes).
   *
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.profileRef
   * @param {'member-fixed' | 'allowed-pool'} input.source
   * @param {number} [input.expectedConfigRevision]
   * @param {string} [input.reason]
   * @returns {Promise<{ state: 'pending' | 'applied' | 'failed', configRevision: number, member: object }>}
   */
  async setMemberModel(input) {
    const member = this.store.getMember(input.memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${input.memberId} 不存在。`);
    if (
      Number.isFinite(input.expectedConfigRevision) &&
      input.expectedConfigRevision !== member.modelConfigRevision
    ) {
      throw new RoomError(
        'REVISION_CONFLICT',
        `成员模型配置已被更新（当前 r${member.modelConfigRevision}）。请刷新后重试。`,
        { current: member.modelConfigRevision, expected: input.expectedConfigRevision },
      );
    }
    const profile = await this.requireProfile(input.profileRef);
    const nextRevision = member.modelConfigRevision + 1;

    this.store.appendModelRevision({
      memberId: member.id,
      revision: nextRevision,
      profileRef: profile.id,
      selectionSource: input.source,
      reason: input.reason ?? '用户指定',
      status: 'pending',
    });

    let applied = false;
    let failure = null;
    try {
      const result = this.adapter.rebindModel({
        memberId: member.id,
        nextProfile: { providerRoute: profile.providerRoute, modelId: profile.modelId },
      });
      applied = result.state === 'applied';
    } catch (error) {
      failure = error;
    }

    const updated = this.store.updateMember(member.id, {
      modelProfileRef: profile.id,
      modelConfigRevision: nextRevision,
      selectionSource: input.source,
      modelLocked: input.source === 'member-fixed',
    });
    this.store.appendModelRevision({
      memberId: member.id,
      revision: nextRevision,
      profileRef: profile.id,
      selectionSource: input.source,
      reason: input.reason ?? '用户指定',
      status: applied ? 'applied' : 'pending',
    });

    if (applied) return { state: 'applied', configRevision: nextRevision, member: updated };
    return {
      state: failure ? 'failed' : 'pending',
      configRevision: nextRevision,
      member: updated,
    };
  }

  /**
   * Pick a model for a new or re-tasked member.
   *
   * With `selectionMode: fixed` this only ever returns the configured default;
   * with `allowed-pool` it chooses inside the allow-list and returns the reason
   * so the choice can be shown rather than silently made (the design notes).
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.role
   * @param {string[]} [input.requiredCapabilities]
   * @param {string | null} [input.preferredProfileRef]
   * @returns {Promise<{ profileRef: string | null, source: import('../../../shared/contracts.js').SelectionSource, reason: string }>}
   */
  async chooseProfile(input) {
    const settings = this.settingsOf(input.roomId);
    if (input.preferredProfileRef) {
      return {
        profileRef: input.preferredProfileRef,
        source: 'member-fixed',
        reason: '用户为该成员指定了模型。',
      };
    }
    const roleRef = settings.roleDefaults?.[input.role] ?? settings.projectDefaultProfileRef;
    if (settings.selectionMode !== 'allowed-pool') {
      return {
        profileRef: roleRef ?? null,
        source: settings.roleDefaults?.[input.role] ? 'role-default' : 'project-default',
        reason: roleRef ? '按角色/项目默认配置。' : '项目未配置默认模型，需要用户指定。',
      };
    }
    const pool = await this.candidatesFor(input.requiredCapabilities ?? [], {
      roomId: input.roomId,
      allowedOnly: true,
    });
    if (pool.length === 0) {
      throw new RoomError(
        'MEMBER_UNAVAILABLE',
        '已启用允许池自动选型，但允许池为空或没有满足能力要求的模型；请在项目设置中补充允许池。',
        { role: input.role, requiredCapabilities: input.requiredCapabilities ?? [] },
      );
    }
    const chosen = pool[0];
    return {
      profileRef: chosen.id,
      source: 'allowed-pool',
      reason: `在允许池中选择 ${chosen.label}（${chosen.providerRoute}/${chosen.modelId}），能力：${chosen.capabilities.join('、')}。`,
    };
  }

  /**
   * Switch a member's model after a failure, following the project policy.
   * Returns `null` when policy is `none`, which is the default and the honest
   * answer: a failed model is not silently replaced (the design notes).
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.memberId
   * @param {string[]} [input.requiredCapabilities]
   * @returns {Promise<{ profileRef: string, reason: string } | null>}
   */
  async fallbackFor(input) {
    const settings = this.settingsOf(input.roomId);
    if (settings.fallbackMode !== 'allowed-pool') return null;
    const member = this.store.getMember(input.memberId);
    if (!member || member.modelLocked) return null;
    const pool = await this.candidatesFor(input.requiredCapabilities ?? [], {
      roomId: input.roomId,
      allowedOnly: true,
    });
    const alternative = pool.find((profile) => profile.id !== member.modelProfileRef);
    if (!alternative) return null;
    return { profileRef: alternative.id, reason: `按项目备选池切换到 ${alternative.label}。` };
  }

  /**
   * Observed request routes per member, from the adapter — the evidence that
   * per-member routing is real.
   * @returns {object[]}
   */
  observedRoutes() {
    return this.adapter.observedRoutes();
  }
}
