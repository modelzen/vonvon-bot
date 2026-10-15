import {createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';

/** A draft without `save` is one whose save is not a harmless write (JoinGroupDialog's would create a
 * real Feishu group), so leaving only offers 继续编辑 and 放弃并离开. */
type Draft = {title: string; save?: () => Promise<boolean>; discard: () => void};
/** 保存并离开 is offered only when every open draft can be saved. */
export const canSaveAll = (drafts: Iterable<Pick<Draft, 'save'>>): boolean => [...drafts].every(draft => draft.save);
type Guard = {
  register: (id: string, draft: Draft) => () => void;
  navigate: (action: () => void) => void;
};
const Context = createContext<Guard | null>(null);

export function DraftGuardProvider({children}: {children: ReactNode}) {
  const drafts = useRef(new Map<string, Draft>());
  const destination = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [savable, setSavable] = useState(true);
  const register = useCallback((id: string, draft: Draft) => {
    drafts.current.set(id, draft);
    return () => { if (drafts.current.get(id) === draft) drafts.current.delete(id); };
  }, []);
  const navigate = useCallback((action: () => void) => {
    if (destination.current) return;
    if (!drafts.current.size) { action(); return; }
    destination.current = action;
    setFailure(undefined);
    setSavable(canSaveAll(drafts.current.values()));
    setOpen(true);
  }, []);
  const context = useMemo(() => ({register, navigate}), [register, navigate]);
  function stay() { destination.current = null; setOpen(false); }
  function proceed() {
    const action = destination.current;
    destination.current = null;
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
  return <Context.Provider value={context}>
    {children}
    <Dialog open={open} title="有未保存的修改" onClose={saving ? undefined : stay}
      footer={<>
        <Button disabled={saving} onClick={stay}>继续编辑</Button>
        <Button disabled={saving} onClick={() => {for (const draft of drafts.current.values()) draft.discard(); drafts.current.clear(); proceed();}}>放弃并离开</Button>
        {savable && <Button variant="primary" loading={saving} onClick={() => void saveAll()}>保存并离开</Button>}
      </>}>
      <p>{savable ? '离开前，请选择如何处理当前修改。' : '离开后，填写的内容不会保留。'}</p>
      {failure && <InlineNotice title="保存未完成" tone="danger">{failure}</InlineNotice>}
    </Dialog>
  </Context.Provider>;
}

export function useDraftGuard() {
  const guard = useContext(Context);
  if (!guard) throw new Error('DraftGuardProvider is required.');
  return guard;
}

export function useDraft(dirty: boolean, draft: Draft) {
  const guard = useContext(Context);
  const id = useId();
  useLayoutEffect(() => dirty ? guard?.register(id, draft) : undefined, [guard, id, dirty, draft]);
}
