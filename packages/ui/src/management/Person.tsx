/** Shared identity row for administrator and group audience pickers. */
export function Person({name, tag}: {name: string; tag?: string}) {
  return <span className="admin-person"><span className="admin-avatar" aria-hidden="true">{[...name.replace(/^…/, '')][0] ?? '?'}</span><span className="admin-name">{name}</span>{tag && <span className="admin-tag">{tag}</span>}</span>;
}
