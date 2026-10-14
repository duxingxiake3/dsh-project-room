/**
 * Project Room — client half.
 *
 * Served to the browser as a CLASSIC script (no ESM, no JSX transform, no
 * bundler), so this file self-registers through the client module loader and
 * builds elements with `react/jsx-runtime`. Only `react` and `react/jsx-runtime`
 * are required explicitly; the shared rules arrive as package-local chunks
 * (`client.vocabulary.js`, `client.mention-resolver.js`) generated from the same
 * source the host runs, which is what makes the `@` preview and the server
 * resolution identical rather than merely similar.
 *
 * Registers two surfaces:
 *   - `sidebar.panellist` id `project-room` → the sidebar button
 *   - `main`              key `project-room` → the whole room workspace
 *
 * The panel is three columns as the design notes asks: projects and members on the
 * left, the group timeline in the middle, tasks/decisions/artifacts on the right.
 * Narrow layouts collapse the outer columns into drawers.
 */

window.__ModuleLoader__.load({
  id: 'dsh-project-room',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const V = require('dsh-project-room#vocabulary');
    const M = require('dsh-project-room#mention-resolver');

    const {
      ROUTE,
      ROLE_TEMPLATES,
      DELIVERY_LABELS,
      TASK_STATUS_LABELS,
      MEMBER_STATUS_LABELS,
      roleTemplate,
      deliveryLabel,
      taskLabel,
      memberLabel,
      isoTimestamp,
    } = V;

    /** Class-name prefix, unique to this plugin. */
    const P = 'dpr_';

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only, so light/dark and any retheme apply.
     * ------------------------------------------------------------------ */
    const CSS = `
.${P}root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.${P}head{display:flex;align-items:center;gap:12px;padding:14px 18px 10px;flex-wrap:wrap}
.${P}title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.${P}sub{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.${P}spacer{flex:1}
.${P}btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:999px;padding:6px 13px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.${P}btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.${P}btn:disabled{opacity:.45;cursor:default}
.${P}btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${P}btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base))}
.${P}btnGhost{border-color:transparent;background:0 0;color:var(--dsw-alias-label-secondary)}
.${P}btnGhost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.${P}btnTiny{font-size:12px;line-height:16px;padding:3px 9px}
.${P}cols{display:flex;flex:1;min-height:0;gap:0;border-top:.5px solid var(--dsw-alias-border-l1)}
.${P}col{display:flex;flex-direction:column;min-height:0;min-width:0}
.${P}colLeft{width:236px;flex:none;border-right:.5px solid var(--dsw-alias-border-l1);overflow:auto}
.${P}colMid{flex:1;min-width:0}
.${P}colRight{width:300px;flex:none;border-left:.5px solid var(--dsw-alias-border-l1);overflow:auto}
.${P}section{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.${P}sectionTitle{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.${P}roomRow{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;font-size:13px;padding:7px 9px;border-radius:8px;border:0;background:0 0;color:inherit;cursor:pointer}
.${P}roomRow:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}roomRowOn{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.${P}memberRow{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer}
.${P}memberRow:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}avatar{width:28px;height:28px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base));background:var(--dsw-alias-brand-primary);user-select:none;cursor:context-menu}
.${P}avatarSm{width:24px;height:24px;font-size:11px}
.${P}dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.${P}dotIdle{background:var(--dsw-alias-state-idle-primary)}
.${P}dotWorking{background:var(--dsw-alias-state-success-primary)}
.${P}dotWaiting{background:var(--dsw-alias-state-warn-primary)}
.${P}dotUser{background:var(--dsw-alias-state-error-primary)}
.${P}dotPaused{background:var(--dsw-alias-label-secondary)}
.${P}name{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}aiTag{font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:none}
.${P}timeline{flex:1;min-height:0;overflow:auto;padding:10px 16px 4px;display:flex;flex-direction:column;gap:12px}
.${P}msg{display:flex;gap:9px;align-items:flex-start}
.${P}msgBody{min-width:0;flex:1}
.${P}msgHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.${P}author{font-size:13px;font-weight:600}
.${P}role{font-size:11px;color:var(--dsw-alias-label-secondary)}
.${P}time{font-size:11px;color:var(--dsw-alias-label-secondary)}
.${P}text{font-size:13.5px;line-height:21px;white-space:pre-wrap;word-break:break-word;margin-top:2px}
.${P}mention{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 3px;font-weight:500}
.${P}replyRef{font-size:11.5px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 7px;margin:3px 0;white-space:pre-wrap}
.${P}chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.${P}chip{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.${P}chipOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.${P}chipWarn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.${P}chipErr{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${P}sys{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;white-space:pre-wrap}
.${P}composer{border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 14px 12px;position:relative}
.${P}editorWrap{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.${P}chipsRow{display:flex;flex-wrap:wrap;gap:6px}
.${P}mChip{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:18px;padding:1px 4px 1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}
.${P}mChipX{border:0;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;padding:0 2px}
.${P}textarea{width:100%;box-sizing:border-box;border:0;background:0 0;outline:0;resize:none;font:inherit;font-size:13.5px;line-height:21px;color:var(--dsw-alias-label-primary);min-height:44px;max-height:180px}
.${P}tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${P}select,.${P}input{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.${P}input{min-width:0;flex:1}
.${P}picker{position:absolute;left:14px;right:14px;bottom:calc(100% - 4px);z-index:40;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px}
.${P}pickerItem{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;padding:6px 8px;border:0;border-radius:8px;background:0 0;color:inherit;cursor:pointer}
.${P}pickerItem:hover,.${P}pickerItemOn{background:var(--dsw-alias-bg-layer-2)}
.${P}menu{position:fixed;z-index:60;min-width:186px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.2);padding:4px}
.${P}menuItem{display:block;width:100%;text-align:left;font:inherit;font-size:13px;padding:6px 10px;border:0;border-radius:7px;background:0 0;color:inherit;cursor:pointer}
.${P}menuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}menuSep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}
.${P}hint{font-size:12px;line-height:17px;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.${P}hintErr{background:0 0;border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${P}hintWarn{background:0 0;border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.${P}empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary)}
.${P}emptyTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.${P}fieldRow{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.${P}label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.${P}checks{display:flex;flex-wrap:wrap;gap:8px}
.${P}check{display:flex;align-items:center;gap:5px;font-size:12.5px}
.${P}card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.${P}cardTitle{font-size:12.5px;font-weight:600;line-height:18px}
.${P}kv{display:flex;gap:6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.${P}kvKey{flex:none;min-width:52px}
.${P}taskRow{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);margin-bottom:6px}
.${P}taskTop{display:flex;align-items:center;gap:6px}
.${P}bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.${P}barFill{height:100%;background:var(--dsw-alias-brand-primary)}
.${P}scroll{overflow:auto}
.${P}nowrap{white-space:nowrap}
.${P}mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.${P}draft{opacity:.72}
@media (max-width:1100px){.${P}colRight{display:none}.${P}colLeft{width:196px}}
@media (max-width:820px){.${P}colLeft{display:none}}
`;

    /* ------------------------------------------------------------------ *
     * Small utilities
     * ------------------------------------------------------------------ */

    /** POST one action to the host half and unwrap its envelope. */
    async function post(action, payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload ?? {}) }),
        credentials: 'same-origin',
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new Error(`宿主通道返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (body && body.ok) return body.data;
      const error = body?.error ?? {};
      const prefix = error.code ? `${V.ERROR_LABELS?.[error.code] ?? error.code}：` : '';
      const failure = new Error(`${prefix}${error.message ?? `请求失败（HTTP ${response.status}）`}`);
      failure.code = error.code ?? 'INTERNAL';
      failure.details = error.details;
      throw failure;
    }

    /** Deterministic avatar colour and initial for one member. */
    function avatarFor(member) {
      const label = member?.displayName ?? member?.memberId ?? '?';
      let hash = 0;
      for (let index = 0; index < label.length; index += 1) hash = (hash * 31 + label.charCodeAt(index)) % 360;
      return { initial: label.slice(0, 1), hue: hash };
    }

    /** Local wall-clock time for a stored UTC timestamp. */
    function timeOf(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    /** A delivery state's chip tone. */
    function toneOf(status) {
      if (status === 'replied' || status === 'claimed') return `${P}chip ${P}chipOk`;
      if (status === 'failed' || status === 'discarded') return `${P}chip ${P}chipErr`;
      if (status === 'paused' || status === 'uncertain') return `${P}chip ${P}chipWarn`;
      return `${P}chip`;
    }

    /** A member status dot's class. */
    function dotOf(status) {
      if (status === 'working') return `${P}dot ${P}dotWorking`;
      if (status === 'awaiting_reply') return `${P}dot ${P}dotWaiting`;
      if (status === 'needs_user') return `${P}dot ${P}dotUser`;
      if (status === 'paused' || status === 'offline') return `${P}dot ${P}dotPaused`;
      return `${P}dot ${P}dotIdle`;
    }

    /* ------------------------------------------------------------------ *
     * Mention-aware text
     * ------------------------------------------------------------------ */

    /**
     * Render a body with the exact spans the server resolved highlighted.
     * The spans come from the stored mention records, not from a second parse,
     * so what the reader sees highlighted is what was actually delivered.
     */
    function MentionText(props) {
      const { body, mentions } = props;
      const segments = useMemo(() => {
        try {
          return M.segmentsForDisplay(body ?? '', mentions ?? []);
        } catch {
          return [{ text: body ?? '', mention: null }];
        }
      }, [body, mentions]);
      return jsx('div', {
        className: `${P}text`,
        children: segments.map((segment, index) =>
          segment.mention
            ? jsx('span', { key: index, className: `${P}mention`, title: `已投递给 ${segment.mention.displaySnapshot || segment.mention.targetMemberId}`, children: segment.text })
            : jsx('span', { key: index, children: segment.text }),
        ),
      });
    }

    /* ------------------------------------------------------------------ *
     * Avatar + context menu (the design notes)
     * ------------------------------------------------------------------ */

    function Avatar(props) {
      const { member, small, onMenu } = props;
      const { initial, hue } = avatarFor(member);
      const style = { background: `hsl(${hue} 62% 46%)` };
      return jsx('button', {
        type: 'button',
        className: small ? `${P}avatar ${P}avatarSm` : `${P}avatar`,
        style,
        title: `${member?.displayName ?? '成员'}（右键或长按：@ 他）`,
        'aria-label': `${member?.displayName ?? '成员'} 的头像，打开成员菜单`,
        onClick: (event) => onMenu?.(event, member),
        onContextMenu: (event) => {
          event.preventDefault();
          onMenu?.(event, member, 'mention');
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onMenu?.(event, member);
          }
        },
        children: initial,
      });
    }

    function MemberMenu(props) {
      const { state, onClose, onPick, members, canReply } = props;
      useEffect(() => {
        const close = () => onClose();
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('click', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [onClose]);
      if (!state.open) return null;
      const member = members.find((entry) => entry.id === state.memberId);
      if (!member) return null;
      const self = member.id === state.selfId;
      const item = (label, action, options) =>
        jsx('button', {
          type: 'button',
          className: `${P}menuItem`,
          onClick: (event) => {
            event.stopPropagation();
            onPick(action, member);
          },
          children: label,
          ...(options ?? {}),
        });
      return jsx('div', {
        className: `${P}menu`,
        style: { left: state.x, top: Math.min(state.y, (window.innerHeight ?? 900) - 260) },
        onClick: (event) => event.stopPropagation(),
        role: 'menu',
        children: [
          item(self ? '@ 自己（留注记，不触发模型）' : `@ 他（${member.displayName}）`, 'mention'),
          canReply && state.messageId ? item('回复这条消息', 'reply') : null,
          jsx('div', { className: `${P}menuSep`, key: 'sep1' }),
          item('查看成员', 'detail'),
          item('选择或更换模型', 'model'),
          item('查看当前任务', 'task'),
          jsx('div', { className: `${P}menuSep`, key: 'sep2' }),
          member.status === 'paused' ? item('恢复该成员', 'resume') : item('暂停该成员', 'pause'),
          member.status === 'offline' ? null : item('让该成员退出本群', 'retire'),
        ].filter(Boolean),
      });
    }

    /* ------------------------------------------------------------------ *
     * Composer (the design notes)
     * ------------------------------------------------------------------ */

    function Composer(props) {
      const { room, members, selfId, onSend, onError, busy } = props;
      const [body, setBody] = useState('');
      const [chips, setChips] = useState([]);
      const [picker, setPicker] = useState({ open: false, query: '', index: 0, start: -1 });
      const [toast, setToast] = useState(null);
      const areaRef = useRef(null);
      const composing = useRef(false);

      const resolver = useMemo(
        () =>
          new M.MentionResolver({
            members,
            membershipRevision: room?.membershipRevision ?? 0,
          }),
        [members, room?.membershipRevision],
      );

      /** Insert a member chip at the caret without disturbing the draft. */
      const insertChip = useCallback(
        (member) => {
          setChips((current) => (current.some((chip) => chip.targetMemberId === member.id) ? current : [...current, { targetMemberId: member.id, origin: 'picker', displaySnapshot: member.displayName, span: null }]));
          setPicker({ open: false, query: '', index: 0, start: -1 });
          const area = areaRef.current;
          if (area) {
            const caret = area.selectionStart ?? body.length;
            const before = body.slice(0, caret);
            const after = area.value.slice(area.selectionEnd ?? caret);
            // Trailing space so a typed name after the chip is never glued to it.
            const next = `${before.replace(/@[^\s@]*$/, '')}${after.startsWith(' ') ? '' : ' '}${after}`;
            setBody(next);
            requestAnimationFrame(() => {
              const position = before.replace(/@[^\s@]*$/, '').length;
              area.focus();
              area.setSelectionRange(position, position);
            });
          }
          areaRef.current?.focus();
        },
        [body],
      );

      /** Recompute the local preview on every keystroke — same rules as the server. */
      const preview = useMemo(() => {
        try {
          const merged = M.mergeMentions({
            body,
            mentions: chips,
            resolver,
            membershipRevision: room?.membershipRevision,
          });
          const nameOf = (memberId) => members.find((member) => member.id === memberId)?.displayName ?? memberId;
          return {
            targets: merged.targets.map((target) => ({ ...target, displayName: nameOf(target.targetMemberId) })),
            unknown: merged.unknownText,
            ambiguous: merged.ambiguous,
            hints: merged.hints,
            stale: merged.stale,
          };
        } catch (error) {
          return { targets: [], unknown: [], ambiguous: [], hints: [String(error?.message ?? error)], stale: false };
        }
      }, [body, chips, resolver, members, room?.membershipRevision]);

      const aiTargetCount = preview.targets.filter((target) => {
        const member = members.find((entry) => entry.id === target.targetMemberId);
        return member?.kind === 'agent';
      }).length;

      /** Detect an `@` right before the caret and open the picker. */
      const syncPicker = useCallback(
        (value, caret) => {
          const before = value.slice(0, caret);
          const match = /(?:^|[\s([{"'「『（【,，。；;:：!！?？])([@＠][^\s@＠]*)$/.exec(before);
          if (!match) {
            setPicker((current) => (current.open ? { ...current, open: false } : current));
            return;
          }
          const query = match[2].slice(1);
          setPicker({ open: true, query, index: 0, start: caret - match[2].length });
        },
        [],
      );

      const candidates = useMemo(() => {
        if (!picker.open) return [];
        const query = picker.query.toLowerCase();
        const inactive = members.filter((member) => member.status !== 'offline' && member.id !== selfId);
        const matched = inactive.filter((member) => {
          if (!query) return true;
          const haystack = [member.displayName, member.handle, member.role, ...(member.aliases ?? [])].join(' ').toLowerCase();
          return haystack.includes(query);
        });
        const everyone = { id: '__everyone__', displayName: '所有人', handle: 'all', role: 'broadcast', kind: 'agent', aliases: [] };
        const allowsEveryone = !query || '所有人'.includes(query) || 'all'.startsWith(query) || 'everyone'.startsWith(query);
        return (allowsEveryone ? [everyone, ...matched] : matched).slice(0, 12);
      }, [picker.open, picker.query, members, selfId]);

      const onKeyDown = (event) => {
        // Never steal Enter/Tab from an in-progress IME composition: a Chinese
        // candidate must be committed by the IME first (the design notes).
        if (composing.current || event.isComposing || event.keyCode === 229) return;
        if (picker.open) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setPicker((current) => ({ ...current, index: Math.min(current.index + 1, candidates.length - 1) }));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setPicker((current) => ({ ...current, index: Math.max(current.index - 1, 0) }));
            return;
          }
          if ((event.key === 'Enter' || event.key === 'Tab') && candidates.length > 0) {
            event.preventDefault();
            const chosen = candidates[picker.index] ?? candidates[0];
            if (chosen.id === '__everyone__') {
              setChips((current) => [
                ...current,
                ...members
                  .filter((member) => member.kind === 'agent' && member.status !== 'offline' && member.id !== selfId)
                  .map((member) => ({ targetMemberId: member.id, origin: 'picker', displaySnapshot: member.displayName, span: null })),
              ]);
              setBody((current) => current.replace(/[@＠][^\s@＠]*$/, ''));
              setPicker({ open: false, query: '', index: 0, start: -1 });
            } else {
              insertChip(chosen);
            }
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setPicker({ open: false, query: '', index: 0, start: -1 });
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void submit();
        }
      };

      const submit = async () => {
        const text = body.trim();
        if (!text && chips.length === 0) return;
        if (preview.ambiguous.length > 0) {
          onError?.(preview.ambiguous[0].reason);
          return;
        }
        try {
          const result = await onSend({
            body: text,
            mentions: chips,
            membershipRevision: room?.membershipRevision,
          });
          setBody('');
          setChips([]);
          setToast({ kind: result?.duplicate ? 'warn' : 'ok', text: result?.duplicate ? '这条消息之前已经发送过，没有重复投递。' : '已发送。' });
          if (result?.warnings?.length) onError?.(result.warnings.join('；'));
        } catch (error) {
          onError?.(String(error?.message ?? error));
        }
      };

      return jsxs('div', {
        className: `${P}composer`,
        children: [
          picker.open && candidates.length > 0
            ? jsx('div', {
                className: `${P}picker`,
                role: 'listbox',
                children: candidates.map((member, index) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className: index === picker.index ? `${P}pickerItem ${P}pickerItemOn` : `${P}pickerItem`,
                      onMouseDown: (event) => {
                        event.preventDefault();
                        if (member.id === '__everyone__') {
                          setChips((current) => [
                            ...current,
                            ...members
                              .filter((entry) => entry.kind === 'agent' && entry.status !== 'offline' && entry.id !== selfId)
                              .map((entry) => ({ targetMemberId: entry.id, origin: 'picker', displaySnapshot: entry.displayName, span: null })),
                          ]);
                          setBody((current) => current.replace(/[@＠][^\s@＠]*$/, ''));
                        } else {
                          insertChip(member);
                        }
                        setPicker({ open: false, query: '', index: 0, start: -1 });
                      },
                      role: 'option',
                      'aria-selected': index === picker.index,
                      children: [
                        jsx(Avatar, { member, small: true, key: 'a' }),
                        jsxs('span', {
                          key: 't',
                          style: { minWidth: 0 },
                          children: [
                            jsx('div', { className: `${P}name`, children: member.id === '__everyone__' ? '所有人' : member.displayName }),
                            jsx('div', {
                              className: `${P}meta`,
                              children:
                                member.id === '__everyone__'
                                  ? `会触达 ${members.filter((entry) => entry.kind === 'agent' && entry.status !== 'offline' && entry.id !== selfId).length} 位 AI 成员`
                                  : `@${member.handle} · ${member.role}${member.aliases?.length ? ` · ${member.aliases.join('/')}` : ''}`,
                            }),
                          ],
                        }),
                      ],
                    },
                    member.id,
                  ),
                ),
              })
            : null,
          jsxs('div', {
            className: `${P}editorWrap`,
            children: [
              chips.length > 0
                ? jsx('div', {
                    className: `${P}chipsRow`,
                    children: chips.map((chip) =>
                      jsxs(
                        'span',
                        {
                          className: `${P}mChip`,
                          children: [
                            jsx('span', { children: `@${chip.displaySnapshot || chip.targetMemberId}` }),
                            jsx('button', {
                              type: 'button',
                              className: `${P}mChipX`,
                              title: '移除这个接收人',
                              onClick: () => setChips((current) => current.filter((entry) => entry.targetMemberId !== chip.targetMemberId)),
                              children: '×',
                            }),
                          ],
                        },
                        chip.targetMemberId,
                      ),
                    ),
                  })
                : null,
              jsx('textarea', {
                ref: areaRef,
                className: `${P}textarea`,
                placeholder: '说点什么，或输入 @ 选人（例如：@前端 为什么这样设计？）',
                value: body,
                rows: 2,
                onChange: (event) => {
                  const value = event.target.value;
                  setBody(value);
                  syncPicker(value, event.target.selectionStart ?? value.length);
                  setToast(null);
                },
                onCompositionStart: () => {
                  composing.current = true;
                },
                onCompositionEnd: (event) => {
                  composing.current = false;
                  const value = event.target.value;
                  syncPicker(value, event.target.selectionStart ?? value.length);
                },
                onKeyDown,
                onClick: (event) => syncPicker(body, event.currentTarget.selectionStart ?? body.length),
                'aria-label': '群消息输入框',
              }),
              jsxs('div', {
                className: `${P}tools`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnGhost ${P}btnTiny`,
                    onClick: () => {
                      setPicker({ open: true, query: '', index: 0, start: -1 });
                      areaRef.current?.focus();
                    },
                    children: '@ 成员',
                  }),
                  jsx('span', {
                    className: `${P}meta`,
                    children:
                      aiTargetCount > 0
                        ? `将触达 ${aiTargetCount} 位 AI 成员${preview.targets.length - aiTargetCount > 0 ? ` + ${preview.targets.length - aiTargetCount} 位人类成员` : ''}`
                        : '没有点名：默认由主代理接收',
                  }),
                  jsx('span', { className: `${P}spacer` }),
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnPrimary`,
                    disabled: busy || (!body.trim() && chips.length === 0),
                    onClick: () => void submit(),
                    children: busy ? '发送中…' : '发送',
                  }),
                ],
              }),
            ],
          }),
          preview.hints.length > 0
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { marginTop: 6 }, children: preview.hints.join('\n') })
            : null,
          preview.ambiguous.length > 0
            ? jsx('div', {
                className: `${P}hint ${P}hintErr`,
                style: { marginTop: 6 },
                children: `${preview.ambiguous[0].reason}（候选：${preview.ambiguous[0].candidates.map((candidate) => candidate.displayName).join('、')}）`,
              })
            : null,
          preview.unknown.length > 0
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { marginTop: 6 }, children: `无法识别的点名会被当作普通文本：${preview.unknown.join('、')}` })
            : null,
          toast ? jsx('div', { className: `${P}hint`, style: { marginTop: 6 }, children: toast.text }) : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Timeline
     * ------------------------------------------------------------------ */

    function Timeline(props) {
      const { messages, members, selfId, onAvatarMenu, onReply } = props;
      const scroller = useRef(null);
      const pinned = useRef(true);

      useEffect(() => {
        const element = scroller.current;
        if (!element) return undefined;
        const onScroll = () => {
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        };
        element.addEventListener('scroll', onScroll);
        return () => element.removeEventListener('scroll', onScroll);
      }, []);

      useEffect(() => {
        const element = scroller.current;
        if (element && pinned.current) element.scrollTop = element.scrollHeight;
      }, [messages]);

      const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
      const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

      return jsx('div', {
        className: `${P}timeline`,
        ref: scroller,
        children: messages.map((message) => {
          const author = memberById.get(message.authorId) ?? { id: message.authorId, displayName: message.authorId, role: '', kind: 'agent' };
          const template = roleTemplate(author.role);
          if (author.kind === 'human' && /^【/.test(message.body)) {
            return jsx('div', { className: `${P}sys`, children: message.body }, message.id);
          }
          const replySource = message.replyTo ? byId.get(message.replyTo) : null;
          const replyAuthor = replySource ? memberById.get(replySource.authorId) : null;
          return jsxs(
            'div',
            {
              className: `${P}msg`,
              children: [
                jsx(Avatar, { member: author, onMenu: (event, member, intent) => onAvatarMenu(event, member, intent, message) }, 'avatar'),
                jsxs(
                  'div',
                  {
                    className: `${P}msgBody`,
                    children: [
                      jsxs(
                        'div',
                        {
                          className: `${P}msgHead`,
                          children: [
                            jsx('span', { className: `${P}author`, children: author.displayName }),
                            author.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, children: 'AI' }) : null,
                            jsx('span', { className: `${P}role`, children: template?.title ?? author.role ?? '' }),
                            jsx('span', { className: `${P}time`, children: `#${message.seq} · ${timeOf(message.createdAt)}` }),
                            message.taskId ? jsx('span', { className: `${P}chip`, children: `任务 ${message.taskId}` }) : null,
                            jsx('span', { className: `${P}spacer` }),
                            jsx('button', {
                              type: 'button',
                              className: `${P}btn ${P}btnGhost ${P}btnTiny`,
                              onClick: () => onReply(message, author),
                              children: '回复',
                            }),
                          ],
                        },
                      ),
                      replySource
                        ? jsx('div', {
                            className: `${P}replyRef`,
                            children: `回复 ${replyAuthor?.displayName ?? replySource.authorId}：#${replySource.seq} ${String(replySource.body).slice(0, 120)}`,
                          })
                        : null,
                      jsx(MentionText, { body: message.body, mentions: message.mentions }),
                      message.deliveries?.length > 0
                        ? jsx('div', {
                            className: `${P}chips`,
                            children: message.deliveries.map((delivery) => {
                              const target = memberById.get(delivery.recipientId);
                              return jsx(
                                'span',
                                {
                                  className: toneOf(delivery.status),
                                  title: delivery.detail ?? '',
                                  children: `${target?.displayName ?? delivery.recipientId}：${deliveryLabel(delivery.status)}`,
                                },
                                delivery.recipientId,
                              );
                            }),
                          })
                        : null,
                    ],
                  },
                  'body',
                ),
              ],
            },
            message.id,
          );
        }),
      });
    }

    /* ------------------------------------------------------------------ *
     * Right column: tasks, decisions, artifacts, recovery
     * ------------------------------------------------------------------ */

    function Board(props) {
      const { room, board, recovery, onAction, error } = props;
      if (!board) return jsx('div', { className: `${P}section`, children: '正在读取任务板…' });
      const tasks = board.tasks ?? [];
      const accepted = tasks.filter((task) => task.status === 'accepted').length;
      const ratio = tasks.length === 0 ? 0 : Math.round((accepted / tasks.length) * 100);
      return jsxs('div', {
        children: [
          jsxs('div', {
            className: `${P}section`,
            children: [
              jsx('h4', { className: `${P}sectionTitle`, children: '任务' }),
              jsxs('div', {
                className: `${P}kv`,
                children: [jsx('span', { className: `${P}kvKey`, children: '进度' }), jsx('span', { children: `${accepted}/${tasks.length} 已验收` })],
              }),
              jsx('div', { className: `${P}bar`, style: { marginTop: 5 }, children: jsx('div', { className: `${P}barFill`, style: { width: `${ratio}%` } }) }),
              jsx('div', { style: { height: 8 } }),
              tasks.length === 0
                ? jsx('div', { className: `${P}meta`, children: '还没有任务。把整体目标交给主代理，它会拆分并派发。' })
                : tasks.map((task) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}taskRow`,
                        children: [
                          jsxs('div', {
                            className: `${P}taskTop`,
                            children: [
                              jsx('span', { className: `${P}chip`, children: taskLabel(task.status) }),
                              jsx('span', { className: `${P}name`, style: { flex: 1 }, children: task.objective }),
                            ],
                          }),
                          jsxs('div', {
                            className: `${P}meta`,
                            children: [
                              `r${task.revision}`,
                              task.ownerName ? ` · ${task.ownerName}` : ' · 未指派',
                              task.needsSync ? ' · 需同步新版本' : '',
                              task.blockedBy?.length ? ` · 等待 ${task.blockedBy.map((entry) => entry.objective).join('、')}` : '',
                            ].join(''),
                          }),
                          task.acceptance?.length
                            ? jsx('div', { className: `${P}meta`, children: `验收：${task.acceptance.join('；')}` })
                            : null,
                          task.artifacts?.length
                            ? jsx('div', {
                                className: `${P}chips`,
                                children: task.artifacts.slice(0, 5).map((artifact) =>
                                  jsx('span', { className: artifact.verified ? `${P}chip ${P}chipOk` : `${P}chip ${P}chipWarn`, children: `${artifact.kind}：${artifact.location}${artifact.verified ? '' : '（未核验）'}` }, artifact.id),
                                ),
                              })
                            : null,
                        ],
                      },
                      task.id,
                    ),
                  ),
            ],
          }),
          jsxs('div', {
            className: `${P}section`,
            children: [
              jsx('h4', { className: `${P}sectionTitle`, children: '项目决定' }),
              (board.decisions ?? []).length === 0
                ? jsx('div', { className: `${P}meta`, children: '还没有采纳的决定。' })
                : board.decisions.map((decision) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}card`,
                        children: [
                          jsxs('div', {
                            className: `${P}cardTitle`,
                            children: [`r${decision.revision} `, decision.status === 'accepted' ? '已采纳' : decision.status === 'proposed' ? '提议中' : decision.status],
                          }),
                          jsx('div', { className: `${P}meta`, children: decision.statement }),
                          decision.acks?.length
                            ? jsx('div', {
                                className: `${P}chips`,
                                children: decision.acks.map((ack) => {
                                  const member = (board.members ?? []).find((entry) => entry.id === ack.memberId);
                                  return jsx('span', { className: `${P}chip`, children: `${member?.displayName ?? ack.memberId}：${ack.state}` }, ack.memberId);
                                }),
                              })
                            : null,
                        ],
                      },
                      decision.id,
                    ),
                  ),
            ],
          }),
          recovery
            ? jsxs('div', {
                className: `${P}section`,
                children: [
                  jsx('h4', { className: `${P}sectionTitle`, children: '投递与恢复' }),
                  jsxs('div', {
                    className: `${P}kv`,
                    children: [jsx('span', { className: `${P}kvKey`, children: '写入者' }), jsx('span', { children: recovery.singleWriter ? '本进程唯一' : '未知' })],
                  }),
                  jsxs('div', {
                    className: `${P}kv`,
                    children: [jsx('span', { className: `${P}kvKey`, children: '上次恢复' }), jsx('span', { children: recovery.lastRecoveryAt ?? '本次会话内尚未恢复' })],
                  }),
                  (recovery.deliveries ?? []).length === 0
                    ? jsx('div', { className: `${P}meta`, children: '没有失败或不确定的投递。' })
                    : recovery.deliveries.map((delivery) =>
                        jsxs(
                          'div',
                          {
                            className: `${P}card`,
                            children: [
                              jsx('div', { className: `${P}cardTitle`, children: `${delivery.label}（#${delivery.seq ?? '?'}）` }),
                              jsx('div', { className: `${P}meta`, children: delivery.detail ?? '' }),
                              jsx('div', {
                                className: `${P}chips`,
                                children: jsx('button', {
                                  type: 'button',
                                  className: `${P}btn ${P}btnTiny`,
                                  onClick: () => onAction('retry', delivery),
                                  children: '核对后重投',
                                }),
                              }),
                            ],
                          },
                          `${delivery.messageId}:${delivery.recipientId}`,
                        ),
                      ),
                  jsx('div', { className: `${P}meta`, style: { marginTop: 6 }, children: recovery.note }),
                ],
              })
            : null,
          error ? jsx('div', { className: `${P}hint ${P}hintErr`, children: error }) : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Member list and detail
     * ------------------------------------------------------------------ */

    function MemberList(props) {
      const { members, selfId, onAvatarMenu, selectedId, onSelect } = props;
      return jsx('div', {
        className: `${P}section`,
        children: members.map((member) =>
          jsxs(
            'div',
            {
              className: `${P}memberRow`,
              onClick: () => onSelect(member),
              style: selectedId === member.id ? { background: 'var(--dsw-alias-bg-layer-2)' } : undefined,
              children: [
                jsx(Avatar, { member, small: true, onMenu: onAvatarMenu }, 'a'),
                jsxs('div', {
                  style: { minWidth: 0, flex: 1 },
                  children: [
                    jsxs('div', {
                      className: `${P}name`,
                      children: [
                        member.displayName,
                        member.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, style: { marginLeft: 5 }, children: 'AI' }) : null,
                        member.id === selfId ? jsx('span', { className: `${P}meta`, style: { marginLeft: 5 }, children: '（你）' }) : null,
                      ],
                    }),
                    jsx('div', {
                      className: `${P}meta`,
                      children: `@${member.handle} · ${roleTemplate(member.role)?.title ?? member.role} · ${memberLabel(member.status)}`,
                    }),
                    member.effectiveModel
                      ? jsx('div', { className: `${P}meta`, children: `${member.effectiveModel.providerRoute}/${member.effectiveModel.modelId}${member.selectionSource === 'member-fixed' ? '（成员固定）' : member.selectionSource === 'role-default' ? '（角色默认）' : member.selectionSource === 'allowed-pool' ? '（允许池）' : '（项目默认）'}` })
                      : jsx('div', { className: `${P}meta`, children: '未配置模型' }),
                    member.currentTask
                      ? jsx('div', { className: `${P}meta`, children: `任务：${member.currentTask.objective}（${taskLabel(member.currentTask.status)} r${member.currentTask.revision}）` })
                      : null,
                  ],
                }),
                jsx('span', { className: dotOf(member.status), title: memberLabel(member.status) }, 'dot'),
              ],
            },
            member.id,
          ),
        ),
      });
    }

    function MemberDetail(props) {
      const { member, models, settings, onModelChange, onControl, onClose, routes } = props;
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState(false);
      const observed = (routes ?? []).find((route) => route.memberId === member.id);
      const options = (models ?? []).filter((profile) => profile.capabilityStatus !== 'unavailable');
      return jsxs('div', {
        className: `${P}section`,
        children: [
          jsxs('div', { className: `${P}msgHead`, children: [jsx('span', { className: `${P}author`, children: member.displayName }), jsx('span', { className: `${P}spacer` }), jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost ${P}btnTiny`, onClick: onClose, children: '关闭' })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '身份' }), jsx('span', { children: `@${member.handle}${member.aliases?.length ? ` · ${member.aliases.join('、')}` : ''}` })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '状态' }), jsx('span', { children: memberLabel(member.status) })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '会话' }), jsx('span', { className: `${P}mono`, children: member.sessionId ?? '未创建' })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '归属' }), jsx('span', { children: member.sessionOwnership === 'borrowed' ? '借用的用户会话（插件不会销毁）' : member.sessionOwnership === 'owned' ? '插件拥有' : '未知' })] }),
          observed
            ? jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '实际路由' }), jsx('span', { children: `${observed.providerRoute}/${observed.modelId}（第 ${observed.turn ?? '?'} 轮请求时观测到）` })] })
            : jsx('div', { className: `${P}meta`, children: '还没有观测到真实请求；改模型后请等它真正执行一次。' }),
          jsxs('div', {
            className: `${P}fieldRow`,
            style: { marginTop: 8 },
            children: [
              jsx('span', { className: `${P}label`, children: '模型（真实已接入的提供方/模型ID）' }),
              jsx('select', {
                className: `${P}select`,
                value: pending ?? member.modelProfileRef ?? '',
                onChange: (event) => setPending(event.target.value),
                children: [
                  jsx('option', { value: '', children: '未配置（使用角色/项目默认）' }),
                  ...options.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}${profile.capabilityStatus === 'unverified' ? '（能力待验证）' : ''}` })),
                ],
              }),
              jsxs('div', {
                className: `${P}tools`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnPrimary ${P}btnTiny`,
                    disabled: busy || !pending || pending === member.modelProfileRef,
                    onClick: async () => {
                      setBusy(true);
                      try {
                        await onModelChange(member, pending);
                        setPending(null);
                      } finally {
                        setBusy(false);
                      }
                    },
                    children: busy ? '切换中…' : '应用模型',
                  }),
                  jsx('span', { className: `${P}meta`, children: `配置版本 r${member.modelConfigRevision} · ${member.modelLocked ? '已锁定' : '未锁定'}` }),
                ],
              }),
              jsx('div', { className: `${P}meta`, children: `切换在安全边界生效：当前请求沿用旧路由，下一次请求使用新模型；成员身份、@ 名称与任务归属不变。项目选型模式：${settings?.selectionMode ?? 'fixed'}` }),
            ],
          }),
          jsxs('div', {
            className: `${P}tools`,
            children: [
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, member.status === 'paused' ? 'resume' : 'pause'), children: member.status === 'paused' ? '恢复' : '暂停' }),
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, 'stop'), children: '停止当前工作' }),
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, 'retire'), children: '退出本群' }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Room creation
     * ------------------------------------------------------------------ */

    function CreateRoom(props) {
      const { models, onCreated, onCancel } = props;
      const [title, setTitle] = useState('');
      const [workspace, setWorkspace] = useState('');
      const [goal, setGoal] = useState('');
      const [roles, setRoles] = useState(['coordinator', 'frontend', 'backend', 'tester']);
      const [modelsByRole, setModelsByRole] = useState({});
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const available = (models ?? []).filter((profile) => profile.capabilityStatus !== 'unavailable');

      const toggle = (role) =>
        setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));

      const submit = async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await post('room.create', {
            title: title.trim() || '未命名项目群',
            workspaceRef: workspace.trim() || null,
            cwd: workspace.trim() || null,
            goal: goal.trim(),
            members: roles.map((role) => ({
              role,
              modelProfileRef: modelsByRole[role] || null,
            })),
          });
          onCreated(result);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };

      return jsxs('div', {
        className: `${P}empty`,
        style: { alignItems: 'stretch', textAlign: 'left', maxWidth: 560, margin: '0 auto' },
        children: [
          jsx('div', { className: `${P}emptyTitle`, children: '新建项目群' }),
          jsx('div', { className: `${P}sub`, children: '一个项目一个群：主代理负责拆分与验收，成员各自使用你选择的真实模型。' }),
          jsxs('div', {
            style: { marginTop: 14 },
            children: [
              jsxs('div', { className: `${P}fieldRow`, children: [jsx('span', { className: `${P}label`, children: '群名称' }), jsx('input', { className: `${P}input`, value: title, placeholder: '例如：验证码登录功能', onChange: (event) => setTitle(event.target.value) })] }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '工作区目录（成员的真实执行目录）' }),
                  jsx('input', { className: `${P}input`, value: workspace, placeholder: 'E:\\my-project', onChange: (event) => setWorkspace(event.target.value) }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '整体目标（提交后主代理会拆分工作）' }),
                  jsx('textarea', {
                    className: `${P}input`,
                    style: { minHeight: 62 },
                    value: goal,
                    placeholder: '例如：做个验证码登录功能，顺便把运行说明补齐。',
                    onChange: (event) => setGoal(event.target.value),
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '初始成员' }),
                  jsx('div', {
                    className: `${P}checks`,
                    children: ROLE_TEMPLATES.map((template) =>
                      jsxs(
                        'label',
                        {
                          className: `${P}check`,
                          children: [
                            jsx('input', { type: 'checkbox', checked: roles.includes(template.role), onChange: () => toggle(template.role) }),
                            template.title,
                          ],
                        },
                        template.role,
                      ),
                    ),
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '每位成员的模型（可留空，之后在成员详情里改）' }),
                  roles.map((role) =>
                    jsxs(
                      'div',
                      {
                        style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 },
                        children: [
                          jsx('span', { style: { width: 68, flex: 'none', fontSize: 12.5 }, children: roleTemplate(role)?.title ?? role }),
                          jsx('select', {
                            className: `${P}select`,
                            style: { flex: 1 },
                            value: modelsByRole[role] ?? '',
                            onChange: (event) => setModelsByRole((current) => ({ ...current, [role]: event.target.value })),
                            children: [
                              jsx('option', { value: '', children: '使用项目/角色默认' }),
                              ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                            ],
                          }),
                        ],
                      },
                      role,
                    ),
                  ),
                ],
              }),
              error ? jsx('div', { className: `${P}hint ${P}hintErr`, children: error }) : null,
              jsxs('div', {
                className: `${P}tools`,
                style: { marginTop: 6 },
                children: [
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnPrimary`, disabled: busy || !roles.length, onClick: () => void submit(), children: busy ? '正在建群…' : '创建项目群' }),
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost`, onClick: onCancel, children: '取消' }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    function ProjectRoomPanel() {
      const [rooms, setRooms] = useState([]);
      const [roomId, setRoomId] = useState(null);
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [creating, setCreating] = useState(false);
      const [menu, setMenu] = useState({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId: null });
      const [selectedMember, setSelectedMember] = useState(null);
      const [replyTo, setReplyTo] = useState(null);
      const [notice, setNotice] = useState(null);

      const selfId = useMemo(() => state?.members?.find((member) => member.kind === 'human')?.id ?? null, [state]);

      const loadRooms = useCallback(async () => {
        try {
          const result = await post('room.list', {});
          setRooms(result.rooms ?? []);
          return result.rooms ?? [];
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return [];
        }
      }, []);

      const loadRoom = useCallback(
        async (id, options) => {
          if (!id) return;
          try {
            const result = await post('room.get', {
              roomId: id,
              afterSeq: options?.afterSeq ?? 0,
              limit: 200,
            });
            setState((current) => {
              if (!current || current.room.id !== id || !options?.afterSeq) return result;
              const seen = new Set(current.messages.map((message) => message.id));
              return { ...result, messages: [...current.messages, ...result.messages.filter((message) => !seen.has(message.id))] };
            });
            setError(null);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [],
      );

      useEffect(() => {
        void (async () => {
          const list = await loadRooms();
          if (list.length > 0) setRoomId((current) => current ?? list[0].id);
        })();
      }, [loadRooms]);

      useEffect(() => {
        if (roomId) void loadRoom(roomId);
      }, [roomId, loadRoom]);

      // Cursor-based refresh: the timeline is a durable record, so a reconnect
      // refills from storage rather than trusting a push it might have missed.
      useEffect(() => {
        if (!roomId) return undefined;
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          const lastSeq = state?.nextSeq ?? 0;
          void loadRoom(roomId, { afterSeq: lastSeq });
        }, 4000);
        return () => clearInterval(timer);
      }, [roomId, state?.nextSeq, loadRoom]);

      const send = useCallback(
        async (input) => {
          if (!state || !selfId) throw new Error('还没有可用的群身份。');
          setBusy(true);
          try {
            const result = await post('room.message.send', {
              roomId: state.room.id,
              actorId: selfId,
              body: input.body,
              mentions: input.mentions,
              replyTo: replyTo?.id ?? null,
              membershipRevision: input.membershipRevision,
              clientMessageId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            });
            setReplyTo(null);
            await loadRoom(state.room.id, { afterSeq: state.nextSeq });
            return result;
          } finally {
            setBusy(false);
          }
        },
        [state, selfId, replyTo, loadRoom],
      );

      const handleMenuPick = useCallback(
        async (action, member) => {
          setMenu({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId });
          if (action === 'mention') {
            // The menu's purpose is to insert a chip without sending (the design notes).
            setNotice({ kind: 'ok', text: `已选择 ${member.displayName}。在输入框按“@ 成员”确认接收人，或直接写 @${member.handle}。` });
            window.dispatchEvent(new CustomEvent('dpr:mention', { detail: { memberId: member.id, displayName: member.displayName } }));
            return;
          }
          if (action === 'reply') {
            const message = state?.messages?.find((entry) => entry.id === menu.messageId);
            if (message) setReplyTo(message);
            return;
          }
          if (action === 'detail' || action === 'model' || action === 'task') {
            setSelectedMember(member);
            return;
          }
          if (action === 'pause' || action === 'resume' || action === 'retire') {
            await control(member, action);
          }
        },
        [state, menu.messageId, selfId],
      );

      const control = useCallback(
        async (member, command) => {
          try {
            if (command === 'retire' && !window.confirm(`让 ${member.displayName} 退出本群？未完成的任务会转为待交接。`)) return;
            await post('room.member.control', { roomId: state.room.id, memberId: member.id, control: command });
            await loadRoom(state.room.id);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      const changeModel = useCallback(
        async (member, profileRef) => {
          try {
            const result = await post('room.member.model.set', {
              roomId: state.room.id,
              memberId: member.id,
              profileRef,
              expectedConfigRevision: member.modelConfigRevision,
              source: 'member-fixed',
            });
            setNotice({
              kind: result.state === 'applied' ? 'ok' : 'warn',
              text:
                result.state === 'applied'
                  ? `已切换 ${member.displayName} 的模型，下一次请求生效；身份、@ 名称与任务归属不变。`
                  : `模型已记录为待切换（${result.state}）；成员的旧配置仍然有效，直到新路由可用。`,
            });
            await loadRoom(state.room.id);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      // The composer asks for a chip when the avatar menu says "@ 他".
      useEffect(() => {
        const handler = (event) => {
          const member = state?.members?.find((entry) => entry.id === event.detail?.memberId);
          if (!member) return;
          setNotice({ kind: 'ok', text: `已把 ${member.displayName} 记为接收人；在输入框里继续写内容即可。` });
        };
        window.addEventListener('dpr:mention', handler);
        return () => window.removeEventListener('dpr:mention', handler);
      }, [state]);

      const onAction = useCallback(
        async (action, payload) => {
          if (action !== 'retry') return;
          try {
            await post('room.delivery.retry', { roomId: state.room.id, messageId: payload.messageId });
            await loadRoom(state.room.id);
            setNotice({ kind: 'ok', text: '已按核对结果重新投递。' });
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      if (creating) {
        return jsxs('div', { className: `${P}root`, children: [jsx('style', { children: CSS }), jsx(CreateRoom, { models: state?.models, onCancel: () => setCreating(false), onCreated: async (result) => { setCreating(false); await loadRooms(); setRoomId(result.room.id); } })] });
      }

      return jsxs('div', {
        className: `${P}root`,
        children: [
          jsx('style', { children: CSS }),
          jsxs('div', {
            className: `${P}head`,
            children: [
              jsxs('div', {
                children: [
                  jsx('h2', { className: `${P}title`, children: state?.room?.title ?? '项目群' }),
                  jsx('p', {
                    className: `${P}sub`,
                    children: state
                      ? `${state.members.filter((member) => member.kind === 'agent').length} 位 AI 成员 · 成员表 r${state.room.membershipRevision} · 计划 r${state.room.planRevision} · 共 ${state.room.lastSeq} 条记录`
                      : '一个项目一个群：主代理拆分工作，成员各自用你选的模型真实执行。',
                  }),
                ],
              }),
              jsx('span', { className: `${P}spacer` }),
              state
                ? jsx('select', {
                    className: `${P}select`,
                    value: roomId ?? '',
                    onChange: (event) => setRoomId(event.target.value),
                    children: rooms.map((room) => jsx('option', { value: room.id, children: `${room.title}（${room.status}）` })),
                  })
                : null,
              jsx('button', { type: 'button', className: `${P}btn`, onClick: () => setCreating(true), children: '新建项目群' }),
              state ? jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost`, onClick: () => void loadRoom(state.room.id), children: '刷新' }) : null,
            ],
          }),
          state?.capabilities?.notes?.length
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { margin: '0 18px 8px' }, children: `当前宿主能力缺口：${state.capabilities.notes.join('；')}` })
            : null,
          error ? jsx('div', { className: `${P}hint ${P}hintErr`, style: { margin: '0 18px 8px' }, children: error }) : null,
          notice ? jsx('div', { className: `${P}hint`, style: { margin: '0 18px 8px' }, children: notice.text }) : null,
          !state
            ? jsxs('div', {
                className: `${P}empty`,
                children: [
                  jsx('div', { className: `${P}emptyTitle`, children: '还没有项目群' }),
                  jsx('div', { children: '新建一个项目群，把整体目标交给主代理，它会把工作拆成有负责人和验收条件的任务。' }),
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnPrimary`, onClick: () => setCreating(true), children: '新建项目群' }),
                ],
              })
            : jsxs('div', {
                className: `${P}cols`,
                children: [
                  jsxs('div', {
                    className: `${P}col ${P}colLeft`,
                    children: [
                      jsx('div', {
                        className: `${P}section`,
                        children: [
                          jsx('h4', { className: `${P}sectionTitle`, children: '项目群' }),
                          rooms.map((room) =>
                            jsx(
                              'button',
                              {
                                type: 'button',
                                className: room.id === roomId ? `${P}roomRow ${P}roomRowOn` : `${P}roomRow`,
                                onClick: () => setRoomId(room.id),
                                children: jsxs('span', {
                                  style: { minWidth: 0 },
                                  children: [jsx('span', { className: `${P}name`, children: room.title }), jsx('span', { className: `${P}meta`, children: `${room.status} · ${room.members} 位成员` })],
                                }),
                              },
                              room.id,
                            ),
                          ),
                        ],
                      }),
                      jsx(MemberList, {
                        members: state.members,
                        selfId,
                        selectedId: selectedMember?.id ?? null,
                        onSelect: (member) => setSelectedMember(member),
                        onAvatarMenu: (event, member, intent) =>
                          setMenu({ open: true, x: event.clientX, y: event.clientY, memberId: member.id, messageId: null, selfId }),
                      }),
                      selectedMember
                        ? jsx(MemberDetail, {
                            member: state.members.find((entry) => entry.id === selectedMember.id) ?? selectedMember,
                            models: state.models,
                            settings: state.modelSettings,
                            routes: state.routes,
                            onClose: () => setSelectedMember(null),
                            onModelChange: changeModel,
                            onControl: control,
                          })
                        : null,
                    ],
                  }),
                  jsxs('div', {
                    className: `${P}col ${P}colMid`,
                    children: [
                      jsx(Timeline, {
                        messages: state.messages,
                        members: state.members,
                        selfId,
                        onReply: (message) => setReplyTo(message),
                        onAvatarMenu: (event, member, intent, message) =>
                          setMenu({ open: true, x: event.clientX, y: event.clientY, memberId: member.id, messageId: message?.id ?? null, selfId }),
                      }),
                      replyTo
                        ? jsx('div', {
                            className: `${P}hint`,
                            style: { margin: '0 14px 6px' },
                            children: jsxs('span', {
                              children: [`正在回复 #${replyTo.seq} `, jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost ${P}btnTiny`, onClick: () => setReplyTo(null), children: '取消引用' })],
                            }),
                          })
                        : null,
                      jsx(Composer, {
                        room: state.room,
                        members: state.members,
                        selfId,
                        busy,
                        onSend: send,
                        onError: (message) => setError(message),
                      }),
                    ],
                  }),
                  jsx('div', {
                    className: `${P}col ${P}colRight`,
                    children: jsx(Board, {
                      room: state.room,
                      board: { ...state.board, members: state.members },
                      recovery: state.recovery,
                      onAction,
                      error: null,
                    }),
                  }),
                ],
              }),
          jsx(MemberMenu, {
            state: menu,
            members: state?.members ?? [],
            canReply: true,
            onClose: () => setMenu({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId }),
            onPick: handleMenuPick,
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    /** Sidebar entry icon: a small room glyph, drawn inline so no asset loads. */
    function RoomIcon() {
      return jsx('svg', {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M4 5.5h16v10H8.5L4 19z', key: 'p' }),
          jsx('path', { d: 'M8.5 9.5h7M8.5 12.5h4', key: 'l' }),
        ],
      });
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'project-room',
            order: 21,
            label: () => '项目群',
          },
          RoomIcon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'project-room',
          },
          ProjectRoomPanel,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = [];
    /** Exposed for verification only; the module loader uses `apply` and `inject`. */
    exports.__internals = {
      ProjectRoomPanel,
      Composer,
      Timeline,
      Board,
      MemberList,
      MemberDetail,
      CreateRoom,
      MemberMenu,
      Avatar,
      MentionText,
      post,
      avatarFor,
      toneOf,
      dotOf,
      CSS,
    };
    return module.exports;
  },
});
