import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "shared-microphone";

export const size = { height: 630, width: 1200 };

export const contentType = "image/png";

const TITLE = "shared-microphone";
const DESCRIPTION = "One microphone, many listeners.";

export default async function Image() {
  /* The same Sora the site uses for headings, cut down to the characters this
     card shows. Change the copy and rebuild it per assets/README.md. */
  const font = await readFile(
    join(process.cwd(), "assets/Sora-700-subset.ttf"),
  );

  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#0b0b0f",
        color: "#ffffff",
        display: "flex",
        height: "100%",
        padding: "0 80px",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          width: 600,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 56,
            fontWeight: 700,
            letterSpacing: -1,
          }}
        >
          {TITLE}
        </div>
        <div
          style={{
            color: "#a1a1aa",
            display: "flex",
            fontSize: 32,
            lineHeight: 1.4,
            marginTop: 28,
          }}
        >
          {DESCRIPTION}
        </div>
        <div
          style={{
            color: "#71717a",
            display: "flex",
            fontSize: 26,
            marginTop: 48,
          }}
        >
          kkweb.io
        </div>
      </div>

      {/* Show the shape of the thing: one device fanning out to several
          consumers. A name and a line of copy alone would make every card in
          the set look the same. */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flex: 1,
          gap: 26,
          justifyContent: "center",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#0ea5e9",
            borderRadius: 999,
            display: "flex",
            height: 104,
            justifyContent: "center",
            width: 104,
          }}
        >
          <svg
            aria-hidden="true"
            fill="none"
            height="54"
            viewBox="0 0 24 24"
            width="54"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm7 9a7 7 0 0 1-6 6.93V22h-2v-3.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2Z"
              fill="#03202b"
            />
          </svg>
        </div>

        {/* the bus: one trunk, three branches */}
        <div style={{ display: "flex", height: 210, width: 8 }}>
          <div
            style={{
              background: "#0ea5e9",
              borderRadius: 999,
              display: "flex",
              height: "100%",
              opacity: 0.5,
              width: 8,
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {["Wake word", "Transcribe", "Record"].map((label) => (
            <div
              key={label}
              style={{ alignItems: "center", display: "flex", gap: 14 }}
            >
              <div
                style={{
                  background: "#0ea5e9",
                  borderRadius: 999,
                  display: "flex",
                  height: 8,
                  opacity: 0.5,
                  width: 34,
                }}
              />
              <div
                style={{
                  alignItems: "center",
                  background: "#15151c",
                  border: "1px solid #26262f",
                  borderRadius: 14,
                  color: "#d4d4d8",
                  display: "flex",
                  fontSize: 22,
                  height: 52,
                  justifyContent: "center",
                  padding: "0 20px",
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [{ data: font, name: "Sora", style: "normal", weight: 700 }],
    },
  );
}
