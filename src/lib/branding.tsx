import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

interface Branding {
  passkeyRequired: boolean;
  brandName: string;
}

const DEFAULT_BRANDING: Branding = {
  passkeyRequired: true,
  brandName: "OpenMail Serverless",
};

interface BrandingContextValue extends Branding {
  loaded: boolean;
  /**
   * Re-fetch /api/config so callers (e.g. the admin "App branding" form) can
   * push a freshly-saved value into the live UI without a hard reload.
   */
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue>({
  ...DEFAULT_BRANDING,
  loaded: false,
  refresh: async () => {},
});

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<Branding & { loaded: boolean }>({
    ...DEFAULT_BRANDING,
    loaded: false,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      const b = (await res.json()) as Partial<Branding>;
      setBranding({
        passkeyRequired:
          typeof b.passkeyRequired === "boolean"
            ? b.passkeyRequired
            : DEFAULT_BRANDING.passkeyRequired,
        brandName:
          typeof b.brandName === "string" && b.brandName.length > 0
            ? b.brandName
            : DEFAULT_BRANDING.brandName,
        loaded: true,
      });
    } catch {
      setBranding((prev) => ({ ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <BrandingContext.Provider value={{ ...branding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
