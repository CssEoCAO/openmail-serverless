import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";

interface Crumb {
  label: string;
  href?: string;
}

/**
 * Builds breadcrumb trail from the current pathname. Top-level routes get
 * a single crumb; edit/new sub-routes get a parent + child trail.
 */
function buildCrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
): Crumb[] {
  // A raiz e' a escolha de caixa; /inbox/... e' uma caixa aberta. A trilha existe
  // aqui porque agora ha para onde voltar — e o breadcrumb some quando ha menos de
  // dois degraus, entao sem estes dois a tela de caixa unica ficaria sem saida
  // visivel que nao fosse o botao do navegador.
  if (pathname === "/") return [{ label: "Caixas" }];
  if (pathname.startsWith("/inbox/")) {
    const bruto = params.inbox;
    const atual =
      !bruto || bruto === "todas"
        ? "Todas juntas"
        : // O parametro vem percent-encoded (endereco tem @). Decodificar pode
          // lancar em URL malformada, e um breadcrumb nunca pode derrubar a pagina.
          (() => {
            try {
              return decodeURIComponent(bruto);
            } catch {
              return bruto;
            }
          })();
    return [{ label: "Caixas", href: "/" }, { label: atual }];
  }

  if (pathname.startsWith("/templates")) {
    if (pathname === "/templates") return [{ label: "Templates" }];
    if (pathname === "/templates/new")
      return [{ label: "Templates", href: "/templates" }, { label: "New" }];
    if (pathname.endsWith("/edit"))
      return [{ label: "Templates", href: "/templates" }, { label: "Edit" }];
    return [{ label: "Templates" }];
  }

  if (pathname.startsWith("/sequences")) {
    if (pathname === "/sequences") return [{ label: "Sequences" }];
    if (pathname === "/sequences/new")
      return [{ label: "Sequences", href: "/sequences" }, { label: "New" }];
    if (pathname.endsWith("/edit"))
      return [{ label: "Sequences", href: "/sequences" }, { label: "Edit" }];
    if (params.id)
      return [{ label: "Sequences", href: "/sequences" }, { label: "Detail" }];
    return [{ label: "Sequences" }];
  }

  if (pathname === "/api-keys") return [{ label: "API Keys" }];
  if (pathname === "/inboxes") return [{ label: "Inboxes" }];
  if (pathname === "/admin/users") return [{ label: "Users" }];
  if (pathname === "/settings") return [{ label: "Settings" }];

  return [];
}

export default function Breadcrumbs() {
  const { pathname } = useLocation();
  const params = useParams();
  const crumbs = buildCrumbs(pathname, params);

  // Hide on top-level pages — the page title already says where you are.
  // Only show the trail on nested routes (e.g. /templates/new, /sequences/:id/edit).
  if (crumbs.length < 2) return null;

  return (
    <div className="relative z-10">
      <nav
        aria-label="Breadcrumb"
        className="mx-auto flex h-7 max-w-[1600px] items-center px-4 pt-2 text-xs md:px-6"
      >
        <ol className="flex items-center gap-1.5">
          <li>
            <Link
              to="/"
              className="flex items-center gap-1.5 text-text-tertiary transition-colors hover:text-text-primary"
              aria-label="Home"
            >
              <Home className="h-3.5 w-3.5" />
            </Link>
          </li>
          {crumbs.map((crumb, i) => (
            <li
              key={`${crumb.label}-${i}`}
              className="flex items-center gap-1.5"
            >
              <ChevronRight className="h-3.5 w-3.5 text-text-tertiary/60" />
              {crumb.href ? (
                <Link
                  to={crumb.href}
                  className="font-light text-text-secondary transition-colors hover:text-text-primary"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-text-primary">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
