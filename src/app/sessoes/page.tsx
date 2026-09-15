import type { Metadata } from "next";
import Link from "next/link";

import { SessionsClient } from "./sessions-client";

export const metadata: Metadata = {
  title: "Minhas sess\u00f5es | GESTOR GMAP"
};

export default function SessionsPage() {
  return (
    <main className="min-h-screen bg-[#f7f8fa] px-5 py-8 text-[#162033]">
      <section className="mx-auto w-full max-w-4xl" aria-labelledby="sessions-title">
        <Link
          href="/"
          className="mb-6 inline-flex min-h-10 items-center text-sm font-bold text-[#176a5e] underline-offset-4 hover:underline focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
        >
          Voltar
        </Link>
        <div className="rounded-lg border border-[#d9dee8] bg-white p-6 sm:p-8">
          <p className="mb-3 text-xs font-bold uppercase text-[#176a5e]">GESTOR GMAP</p>
          <h1 id="sessions-title" className="text-3xl leading-tight font-bold text-[#162033]">
            {"Minhas sess\u00f5es"}
          </h1>
          <p className="mt-2 text-sm text-[#5c667a]">
            {
              "Acompanhe os acessos ativos e encerre sess\u00f5es que n\u00e3o devem permanecer abertas."
            }
          </p>
          <SessionsClient />
        </div>
      </section>
    </main>
  );
}
