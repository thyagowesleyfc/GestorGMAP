export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f8fa] px-5 py-8 text-[#162033]">
      <section
        className="w-full max-w-xl rounded-lg border border-[#d9dee8] bg-white p-6 sm:p-8"
        aria-labelledby="app-title"
      >
        <p className="mb-3 text-xs font-bold uppercase text-[#176a5e]">SEDUC/PI</p>
        <h1 id="app-title" className="text-4xl leading-tight font-bold sm:text-5xl">
          GESTOR GMAP
        </h1>
        <p className="mt-4 leading-7 text-[#5c667a]">
          {"Ger\u00eancia de Materiais e Patrim\u00f4nio"}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href="/login"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#176a5e] px-5 text-sm font-bold text-white transition-colors hover:bg-[#12564d] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
          >
            Entrar
          </a>
          <a
            href="/sessoes"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-[#176a5e] px-5 text-sm font-bold text-[#176a5e] transition-colors hover:bg-[#edf6f3] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
          >
            {"Minhas sess\u00f5es"}
          </a>
        </div>
      </section>
    </main>
  );
}
