import { useSession } from "@/lib/auth-client";
import { Navigate } from "react-router-dom";
import AdminInboxTable from "@/components/AdminInboxTable";
import PageHeader, { PageContainer } from "@/components/PageHeader";

import { tx } from "@/lib/i18n";
export default function InboxesPage() {
  const { data: session } = useSession();
  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <PageContainer>
      <PageHeader
        title={tx("Caixas e envio")}
        subtitle={tx(
          "Nome de exibição, modo de leitura (chat ou fio), provedor de envio, encaminhamento e quem acessa cada caixa.",
        )}
      />
      <AdminInboxTable />
    </PageContainer>
  );
}
