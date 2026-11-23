import { createContext, useContext } from 'react';

type PaletteState = { open: boolean; setOpen: (open: boolean) => void };

export const PaletteContext = createContext<PaletteState>({ open: false, setOpen: () => {} });

export const usePalette = () => useContext(PaletteContext);
