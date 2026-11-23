import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';

type AccountPage = {isOpen: boolean; open: () => void; close: () => void};
const Context = createContext<AccountPage | undefined>(undefined);

/** Account navigation belongs to this window, including while its selected device is unavailable. */
export function AccountPageProvider({children}: {children: ReactNode}) {
  const [isOpen, setOpen] = useState(false);
  const value = useMemo(() => ({isOpen, open: () => setOpen(true), close: () => setOpen(false)}), [isOpen]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccountPage() {return useContext(Context);}
