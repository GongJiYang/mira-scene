/**
 * D49 / S6n §5：设置面板（模式切换 + 浏览器自带 Key）。
 *
 * - 桌面：顶栏「设置」按钮触发一个对话框；
 * - 手机：右上角菜单里的「设置」项触发的底部抽屉。
 *
 * 只读视图模型（D14）；写入经 intents（`saveSettings` / `clearKeys` / `applyMode`）。
 * 文案全部来自 `settings.ts` 的 `SETTINGS_TEXT`（铁律 6）。样式只求清楚可用（S6u 统一重做）。
 */
import { useEffect, useState } from "react";
import { SETTINGS_TEXT, capabilityLabel, type CapabilitySource, type RequestedMode, type Settings } from "../live/settings";
import { UI_TEXT } from "./uiText";
import type { StageViewModel } from "../view/useStageViewModel";

/** 三组 Key 的来源（来自 session.capabilities；未连接时为空）。 */
type Caps = { llm: CapabilitySource; voice: CapabilitySource; image: CapabilitySource } | null;

/** 密码输入框：默认遮住，带「显示 / 隐藏」切换。 */
function SecretInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="settings-secret">
      <input
        type={visible ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="settings-secret-toggle" onClick={() => setVisible((current) => !current)}>
        {visible ? SETTINGS_TEXT.hide : SETTINGS_TEXT.show}
      </button>
    </span>
  );
}

/** 一组 Key 的名称 + 来源标签。 */
function SourceLabel({ source }: { source: CapabilitySource | undefined }) {
  if (source === undefined) return null;
  return (
    <span className="settings-source" data-source={source} data-testid={`settings-source-${source}`}>
      {capabilityLabel(source)}
    </span>
  );
}

const MODES: ReadonlyArray<{ value: RequestedMode; label: string }> = [
  { value: "auto", label: SETTINGS_TEXT.modeAuto },
  { value: "mock", label: SETTINGS_TEXT.modeMock },
  { value: "real", label: SETTINGS_TEXT.modeReal },
];

/** 面板主体（桌面对话框与手机抽屉共用）。 */
export function SettingsBody({ vm, onClose }: { vm: StageViewModel; onClose: () => void }) {
  const [draft, setDraft] = useState<Settings>(vm.settings);
  // 面板每次打开都从最新设置回显。
  useEffect(() => setDraft(vm.settings), [vm.settings]);
  const caps: Caps = vm.capabilities;

  const set = (patch: Partial<Settings>): void => setDraft((current) => ({ ...current, ...patch }));

  return (
    <div className="settings-body" data-testid="settings-body">
      <div className="settings-row">
        <span className="settings-label">{SETTINGS_TEXT.modeGroup}</span>
        <div className="settings-modes" data-testid="settings-mode">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className="settings-mode"
              data-testid={`settings-mode-${mode.value}`}
              data-active={draft.mode === mode.value}
              onClick={() => set({ mode: mode.value })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-head">
          <span className="settings-label">{SETTINGS_TEXT.llmGroup}</span>
          <SourceLabel source={caps?.llm} />
        </div>
        <SecretInput value={draft.deepseekKey} placeholder={SETTINGS_TEXT.deepseekKey} onChange={(value) => set({ deepseekKey: value })} />
      </div>

      <div className="settings-group">
        <div className="settings-group-head">
          <span className="settings-label">{SETTINGS_TEXT.voiceGroup}</span>
          <SourceLabel source={caps?.voice} />
        </div>
        <SecretInput value={draft.fishKey} placeholder={SETTINGS_TEXT.fishKey} onChange={(value) => set({ fishKey: value })} />
        <input
          type="text"
          className="settings-text"
          value={draft.fishVoiceId}
          placeholder={SETTINGS_TEXT.fishVoiceId}
          onChange={(event) => set({ fishVoiceId: event.target.value })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-head">
          <span className="settings-label">{SETTINGS_TEXT.imageGroup}</span>
          <SourceLabel source={caps?.image} />
        </div>
        <SecretInput value={draft.imageKey} placeholder={SETTINGS_TEXT.imageKey} onChange={(value) => set({ imageKey: value })} />
        <input
          type="text"
          className="settings-text"
          value={draft.imageBaseUrl}
          placeholder={SETTINGS_TEXT.imageBaseUrl}
          onChange={(event) => set({ imageBaseUrl: event.target.value })}
        />
        <input
          type="text"
          className="settings-text"
          value={draft.imageModel}
          placeholder={SETTINGS_TEXT.imageModel}
          onChange={(event) => set({ imageModel: event.target.value })}
        />
      </div>

      <p className="settings-note">{SETTINGS_TEXT.privacyNote}</p>

      <div className="settings-actions">
        <button type="button" className="settings-save" data-testid="settings-save" onClick={() => { vm.intents.saveSettings(draft); onClose(); }}>
          {SETTINGS_TEXT.save}
        </button>
        <button type="button" className="settings-clear" data-testid="settings-clear" onClick={() => { vm.intents.clearKeys(); setDraft((current) => ({ ...current, deepseekKey: "", fishKey: "", fishVoiceId: "", imageKey: "", imageBaseUrl: "", imageModel: "" })); }}>
          {SETTINGS_TEXT.clear}
        </button>
      </div>
    </div>
  );
}

/** 桌面：顶栏「设置」按钮 + 对话框。 */
export function SettingsDialogDesktop({ vm }: { vm: StageViewModel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-desktop" data-testid="settings-wrap" data-no-stage-tap>
      <button type="button" className="live-entry" data-testid="settings-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {SETTINGS_TEXT.title}
      </button>
      {open && (
        <div className="settings-dialog" data-testid="settings-dialog" role="dialog" aria-label={SETTINGS_TEXT.title}>
          <div className="settings-dialog-head">
            <span>{SETTINGS_TEXT.title}</span>
            <button type="button" className="settings-close" data-testid="settings-close" aria-label={UI_TEXT.close} onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <SettingsBody vm={vm} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** 手机：底部抽屉（由 MobileMenu 里的「设置」项控制展开）。 */
export function SettingsDrawerMobile({ vm, open, onClose }: { vm: StageViewModel; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="settings-drawer" data-testid="settings-dialog" data-no-stage-tap>
      <div className="settings-drawer-head">
        <span>{SETTINGS_TEXT.title}</span>
        <button type="button" className="settings-close" data-testid="settings-close" onClick={onClose}>
          ×
        </button>
      </div>
      <SettingsBody vm={vm} onClose={onClose} />
    </div>
  );
}

/** §5：顶栏模式小标签（Mock / 真实）。未连接时不显示。 */
export function ModeBadge({ vm }: { vm: StageViewModel }) {
  if (vm.sessionMode === null) return null;
  const text = vm.sessionMode === "real" ? SETTINGS_TEXT.badgeReal : SETTINGS_TEXT.badgeMock;
  return (
    <span className="live-mode-badge" data-testid="mode-badge" data-mode={vm.sessionMode}>
      {text}
    </span>
  );
}
