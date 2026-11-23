import {createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';

export type DraftDiscardEligibility = {kind: 'allowed'} | {kind: 'blocked'; reason: string};

/** A draft without `save` is one whose save is not a harmless write (JoinGroupDialog's would create a
 * real Feishu group), so leaving only offers 继续编辑 and 放弃并离开. */
type Draft = {autoSave?: boolean; title: string; save?: () => Promise<boolean>; discard: () => void; discardEligibility?: () => DraftDiscardEligibility; leaveDescription?: string; leaveLabel?: string};
/** 保存并离开 is offered only when every open draft can be saved. */
export function canSaveAll(drafts: Iterable<Pick<Draft, 'save'>>): boolean {
  return [...drafts].every(draft => Boolean(draft.save));
}
type Guard = {
  register: (id: string, draft: Draft) => () => void;
  navigate: (action: () => void, onCancel?: () => void) => boolean;
};
const Context = createContext<Guard | null>(null);

export function DraftGuardProvider({children}: {children: ReactNode}) {
  const drafts = useRef(new Map<string, Draft>());
  const destination = useRef<(() => void) | null>(null);
  const cancellation = useRef<(() => void) | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [savable, setSavable] = useState(true);
  const [leaveDetails, setLeaveDetails] = useState<{description?: string; label?: string}>({});
  const [discardBlocked, setDiscardBlocked] = useState<string>();
  const refresh = useCallback(() => {
    setSavable(canSaveAll(drafts.current.values()));
    const pending = [...drafts.current.values()].find(draft => draft.leaveDescription);
    setLeaveDetails({description: pending?.leaveDescription, label: pending?.leaveLabel});
    const blocked = [...drafts.current.values()].map(draft => draft.discardEligibility?.()).find(eligibility => eligibility?.kind === 'blocked');
    setDiscardBlocked(blocked?.kind === 'blocked' ? blocked.reason : undefined);
  }, []);
  const register = useCallback((id: string, draft: Draft) => {
    drafts.current.set(id, draft);
    refresh();
    return () => { if (drafts.current.get(id) === draft) {drafts.current.delete(id); queueMicrotask(refresh);} };
  }, [refresh]);
  const navigate = useCallback((action: () => void, onCancel?: () => void) => {
    if (destination.current) return false;
    if (!drafts.current.size) { action(); return true; }
    destination.current = action;
    cancellation.current = onCancel;
    const pending = [...drafts.current];
    if (pending.every(([, draft]) => draft.autoSave && draft.save)) {
      void (async () => {
        try {
          for (const [id, draft] of pending) {
            if (!await draft.save!()) return;
            if (drafts.current.get(id) === draft) drafts.current.delete(id);
          }
          // A newer draft opened during the save remains on its page.
          if (!drafts.current.size) {cancellation.current = undefined; action();}
        } finally {
          destination.current = null;
          const cancel = cancellation.current; cancellation.current = undefined; cancel?.();
        }
      })().catch(() => { /* Inline editors own their error feedback and retain the draft. */ });
      return true;
    }
    setFailure(undefined);
    refresh();
    setOpen(true);
    return true;
  }, [refresh]);
  const context = useMemo(() => ({register, navigate}), [register, navigate]);
  function stay() { destination.current = null; setOpen(false); const cancel = cancellation.current; cancellation.current = undefined; cancel?.(); }
  function proceed() {
    const action = destination.current;
    destination.current = null;
    cancellation.current = undefined;
    setOpen(false);
    action?.();
  }
  async function saveAll() {
    setSaving(true);
    setFailure(undefined);
    try {
      for (const [id, draft] of [...drafts.current]) {
        if (!draft.save || !await draft.save()) {
          setFailure(`“${draft.title}”未能保存。修改仍保留在当前页面。`);
          return;
        }
        if (drafts.current.get(id) === draft) drafts.current.delete(id);
      }
      proceed();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败，修改仍保留。');
    } finally { setSaving(false); }
  }
  function discardAll() {
    if (saving) return;
    const pending = [...drafts.current.values()];
    if (pending.some(draft => draft.discardEligibility?.().kind === 'blocked')) {refresh(); return;}
    for (const draft of pending) draft.discard();
    drafts.current.clear();
    proceed();
  }
  return <Context.Provider value={context}>
    {children}
    <Dialog open={open} title="有未保存的修改" onClose={saving ? undefined : stay}
      footer={<>
        <Button disabled={saving} onClick={stay}>继续编辑</Button>
        <Button disabled={saving || Boolean(discardBlocked)} onClick={discardAll}>{leaveDetails.label ?? '放弃并离开'}</Button>
        {savable && <Button variant="primary" loading={saving} onClick={() => void saveAll()}>保存并离开</Button>}
      </>}>
      <p>{savable ? '离开前，请选择如何处理当前修改。' : '离开后，填写的内容不会保留。'}</p>
      {leaveDetails.description && <p>{leaveDetails.description}</p>}
      {discardBlocked && <p>{discardBlocked}</p>}
      {failure && <InlineNotice title="保存未完成" tone="danger">{failure}</InlineNotice>}
    </Dialog>
  </Context.Provider>;
}

export function useDraftGuard() {
  const guard = useContext(Context);
  if (!guard) throw new Error('DraftGuardProvider is required.');
  return guard;
}

export function useOptionalDraftGuard() {return useContext(Context);}

export function useDraft(dirty: boolean, draft: Draft) {
  const guard = useContext(Context);
  const id = useId();
  useLayoutEffect(() => dirty ? guard?.register(id, draft) : undefined, [guard, id, dirty, draft]);
}


/** Map editors save in place before navigation; failures stay visible at the edited node. */
export function useInlineDraft(dirty: boolean, save: () => Promise<boolean>) {
  const latest = useRef(save);
  latest.current = save;
  const draft = useMemo<Draft>(() => ({title: '导图节点', autoSave: true, save: () => latest.current(), discard: () => {}}), []);
  useDraft(dirty, draft);
}
