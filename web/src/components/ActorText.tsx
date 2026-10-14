import Link from "next/link";
import FigurePortrait from "./FigurePortrait";
import { getActorIndex, splitActors } from "@/lib/actors";

/**
 * Running text with tracked figures' names linked to their pages. See
 * lib/actors.ts for what counts as a mention.
 *
 * `quiet` is for a record card's title, which is itself the card's link: the
 * names look like the rest of the title until the card is hovered, so the
 * title still reads as one line rather than a row of links.
 */
export default async function ActorText({
  text,
  exclude,
  quiet = false,
}: {
  text: string;
  /** The record's own figure, which the page is already about. */
  exclude?: string | null;
  quiet?: boolean;
}) {
  const index = await getActorIndex();
  return (
    <>
      {splitActors(text, index, exclude).map((s, i) =>
        typeof s === "string" ? (
          s
        ) : (
          <Link
            key={i}
            href={`/tokoh/${s.actor.id}`}
            className={quiet ? "actor-link actor-link--quiet" : "actor-link"}
          >
            {s.text}
            <span className="actor-tip" aria-hidden>
              <FigurePortrait figureId={s.actor.id} name={s.actor.name} width={30} round fontSize={11} hatchStep={3} inline />
              <span>
                <span className="actor-tip-name">{s.actor.name}</span>
                {s.actor.role ? <span className="actor-tip-role">{s.actor.role}</span> : null}
              </span>
            </span>
          </Link>
        )
      )}
    </>
  );
}
