import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { OperationalTabGuard } from "./operational-tab-guard";

export const metadata: Metadata = {
  title: "GESTOR GMAP",
  description: "Shell inicial do GESTOR GMAP."
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="pt-BR">
      <body>
        <OperationalTabGuard>{children}</OperationalTabGuard>
      </body>
    </html>
  );
}
