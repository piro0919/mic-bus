import { ImageResponse } from "next/og";

export const size = { height: 180, width: 180 };

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg
        aria-hidden="true"
        fill="none"
        height="112"
        viewBox="0 0 24 24"
        width="112"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm7 9a7 7 0 0 1-6 6.93V22h-2v-3.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2Z"
          fill="#ffffff"
        />
      </svg>
    </div>,
    { ...size },
  );
}
