import Link from "next/link";
import { BrowserContribution } from "./browser-contribution";

export const metadata = {
  title: "Transcribe locally · Transcript Registry",
  description:
    "Run Whisper in your browser and publish only the resulting transcript.",
};

export default function ContributePage() {
  return (
    <main>
      <p>
        <Link href="/">← Transcript Registry</Link>
      </p>
      <h1>Transcribe on this device</h1>
      <p>
        The selected audio or video stays inside this browser. A dedicated
        worker decodes it and runs Whisper locally; the Registry receives only
        progress metadata and, after completion, the transcript you have
        permission to publish.
      </p>
      <p className="muted">
        The model is downloaded once and cached by the browser. WebGPU is used
        when available, with a WASM fallback. Closing the browser pauses active
        compute; reopen this page to resume from the last checkpoint.
      </p>
      <BrowserContribution />
      <section>
        <h2>Command-line fallback</h2>
        <p>
          For unsupported browsers or machines with a faster native Whisper
          runtime, use the existing{" "}
          <Link href="/contribute.txt">local contribution helper</Link>.
        </p>
      </section>
    </main>
  );
}
