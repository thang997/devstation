/**
 * Repository settings (kiểu GitHub Desktop → Repository settings): repo nằm ở đâu trên máy, remote + link web,
 * nhánh upstream, danh tính commit. Sửa / thêm / xoá remote ngay tại chỗ. URL có nhúng token → Rust đã bỏ mật khẩu
 * trước khi trả về (không hiện / không copy bí mật).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink, FolderGit2, FolderOpen, GitBranch, Globe, Pencil, Plus, RefreshCw, Settings, Trash2, TriangleAlert, User, X } from "lucide-react";
import { Modal } from "../../shell/Modal";
import { Loading } from "../../shell/Loading";
import { copyText } from "../../shell/clipboard";
import { confirmDialog } from "../../shell/confirm";
import { useT } from "../../store/lang";
import { git, errText, repoSettings, type RepoInfo, type RemoteInfo } from "./api";

/* store nhỏ: modal đang mở cho repo nào */
let current: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export const openRepoSettings = (path: string) => { current = path; emit(); };
const closeRepoSettings = () => { current = null; emit(); };
const useRepoSettingsPath = () =>
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => current);

/** Đặt một lần ở gốc app Git. */
export function RepoSettingsHost() {
  const tr = useT();
  const path = useRepoSettingsPath();
  if (!path) return null;
  return (
    <Modal title={<><Settings /> {tr("git.repoSettings")}</>} width={680} onClose={closeRepoSettings}>
      <RepoSettings path={path} />
    </Modal>
  );
}

type Edit = { kind: "url"; name: string; url: string } | { kind: "add"; name: string; url: string } | null;

function RepoSettings({ path }: { path: string }) {
  const tr = useT();
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Edit>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError("");
    repoSettings.info(path).then(setInfo, (e) => setError(errText(e)));
  }, [path]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setEdit(null);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!edit) return;
    const name = edit.name.trim(), url = edit.url.trim();
    if (!name || !url) return;
    if (edit.kind === "url") void act(() => repoSettings.setUrl(path, name, url));
    else void act(() => repoSettings.add(path, name, url));
  };

  const remove = (r: RemoteInfo) => {
    void confirmDialog({ message: tr("git.rsRemoveConfirm", { name: r.name }), confirmLabel: tr("git.rsRemoveRemote") })
      .then((ok) => { if (ok) void act(() => repoSettings.remove(path, r.name)); });
  };

  const editKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); setEdit(null); }
  };

  if (!info) {
    return error
      ? <div className="error-box pre"><TriangleAlert /> {error}</div>
      : <Loading />;
  }

  return (
    <div className="rs">
      <section className="rs-sec">
        <div className="rs-cap"><FolderGit2 /> {tr("git.rsLocation")}</div>
        <div className="rs-line">
          <span className="mono grow rs-val" title={info.path}>{info.path}</span>
          <button className="icon-btn" title={tr("git.rsCopyPath")} onClick={() => void copyText(info.path)}><Copy /></button>
          <button onClick={() => void git.reveal(info.path).catch((e) => setError(errText(e)))}><FolderOpen /> {tr("git.rsShowInExplorer")}</button>
        </div>
        {info.gitDir && info.gitDir !== `${info.path}\\.git` && info.gitDir !== `${info.path}/.git` && (
          <div className="muted small mono rs-sub" title={info.gitDir}>{tr("git.rsGitDir")}: {info.gitDir}</div>
        )}
      </section>

      <section className="rs-sec">
        <div className="rs-cap"><GitBranch /> {tr("git.rsBranch")}</div>
        <div className="rs-line">
          <span className="mono">{info.branch ?? tr("git.rsDetached")}</span>
          <span className="muted">→</span>
          {info.upstream
            ? <span className="mono">{info.upstream}</span>
            : <span className="muted">{tr("git.rsNoUpstream")}</span>}
        </div>
      </section>

      <section className="rs-sec">
        <div className="rs-cap">
          <Globe /> {tr("git.rsRemotes")}
          <span className="grow" />
          <button className="icon-btn" title={tr("git.rsRefresh")} onClick={load}><RefreshCw /></button>
        </div>
        {info.remotes.length === 0 && edit?.kind !== "add" && <div className="muted small">{tr("git.rsNoRemotes")}</div>}
        {info.remotes.map((r) =>
          edit?.kind === "url" && edit.name === r.name ? (
            <div key={r.name} className="rs-remote">
              <div className="rs-line">
                <span className="badge rs-name">{r.name}</span>
                <input
                  className="mono grow"
                  autoFocus
                  value={edit.url}
                  placeholder="https://github.com/user/repo.git"
                  onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  onKeyDown={editKeys}
                />
                <button className="primary" disabled={busy || !edit.url.trim() || edit.url.trim() === r.fetch} onClick={save}><Check /> {tr("git.rsSave")}</button>
                <button onClick={() => setEdit(null)}><X /> {tr("git.cancel")}</button>
              </div>
              {r.secret && <div className="muted small rs-sub">{tr("git.rsSecret")}</div>}
            </div>
          ) : (
            <div key={r.name} className="rs-remote">
              <div className="rs-line">
                <span className="badge rs-name">{r.name}</span>
                {r.web
                  ? <a className="mono grow rs-val rs-link" href={r.web} title={r.web} onClick={(e) => { e.preventDefault(); void repoSettings.openWeb(r.web!).catch((er) => setError(errText(er))); }}>{r.fetch}</a>
                  : <span className="mono grow rs-val" title={r.fetch}>{r.fetch}</span>}
                {r.web && (
                  <button className="icon-btn" title={`${tr("git.rsOpenWeb")} — ${r.web}`} onClick={() => void repoSettings.openWeb(r.web!).catch((e) => setError(errText(e)))}><ExternalLink /></button>
                )}
                <button className="icon-btn" title={tr("git.rsCopyUrl")} onClick={() => void copyText(r.fetch)}><Copy /></button>
                <button className="icon-btn" title={tr("git.rsEditUrl")} disabled={busy} onClick={() => setEdit({ kind: "url", name: r.name, url: r.fetch })}><Pencil /></button>
                <button className="icon-btn danger" title={tr("git.rsRemoveRemote")} disabled={busy} onClick={() => remove(r)}><Trash2 /></button>
              </div>
              {r.push && <div className="muted small mono rs-sub">{tr("git.rsPushUrl")}: {r.push}</div>}
              {r.secret && <div className="muted small rs-sub">{tr("git.rsSecretHidden")}</div>}
            </div>
          ),
        )}
        {edit?.kind === "add" ? (
          <div className="rs-line rs-remote">
            <input
              className="rs-name-input"
              autoFocus
              value={edit.name}
              placeholder={tr("git.rsRemoteName")}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              onKeyDown={editKeys}
            />
            <input
              className="mono grow"
              value={edit.url}
              placeholder="https://github.com/user/repo.git"
              onChange={(e) => setEdit({ ...edit, url: e.target.value })}
              onKeyDown={editKeys}
            />
            <button className="primary" disabled={busy || !edit.name.trim() || !edit.url.trim()} onClick={save}><Check /> {tr("git.rsAdd")}</button>
            <button onClick={() => setEdit(null)}><X /> {tr("git.cancel")}</button>
          </div>
        ) : (
          <div>
            <button disabled={busy} onClick={() => setEdit({ kind: "add", name: info.remotes.some((r) => r.name === "origin") ? "" : "origin", url: "" })}>
              <Plus /> {tr("git.rsAddRemote")}
            </button>
          </div>
        )}
      </section>

      <section className="rs-sec">
        <div className="rs-cap"><User /> {tr("git.rsIdentity")}</div>
        <div className="rs-line">
          {info.userName || info.userEmail
            ? <span>{info.userName ?? "?"} <span className="muted">&lt;{info.userEmail ?? "?"}&gt;</span></span>
            : <span className="muted">{tr("git.rsIdentityNone")}</span>}
          <span className="badge">{info.identityLocal ? tr("git.rsIdentityLocal") : tr("git.rsIdentityGlobal")}</span>
        </div>
      </section>

      {error && <div className="error-box pre"><TriangleAlert /> {error}</div>}
    </div>
  );
}
