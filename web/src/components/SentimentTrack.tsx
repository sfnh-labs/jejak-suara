import {
  SENTIMENT_GRADIENT,
  markerLeft,
  sentimentEmoji,
  sentimentLabel,
} from "@/lib/design";

/**
 * The gradient sentiment bar with its emoji marker.
 *
 * The emoji carries an aria-label because it is the only indicator of the
 * value for anyone not seeing the colour.
 */
export default function SentimentTrack({
  display,
  height = 8,
  thumb = 26,
}: {
  display: number;
  height?: number;
  thumb?: number;
}) {
  return (
    <div
      role="img"
      aria-label={`Sentimen publik: ${display > 0 ? "+" : ""}${display}, ${sentimentLabel(display)}`}
      style={{
        position: "relative",
        height,
        borderRadius: 99,
        background: SENTIMENT_GRADIENT,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: markerLeft(display),
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: thumb,
          height: thumb,
          borderRadius: "50%",
          background: "#f6f2e9",
          border: "1px solid #16130f",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(thumb * 0.54),
        }}
      >
        {sentimentEmoji(display)}
      </div>
    </div>
  );
}
