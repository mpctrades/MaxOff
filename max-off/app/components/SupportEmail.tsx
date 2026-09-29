/**
 * The one place MaxOff tells a merchant how to reach a person.
 *
 * Every "contact support" in the app used to end there, with no address
 * anywhere in the UI. These are the messages a merchant with a billing or
 * data problem is reading, so the way to ask is written into the sentence.
 */
export const SUPPORT_EMAIL = "team@mpctrades.com";

/** "Email team@mpctrades.com", as a mailto link. Lowercase mid-sentence. */
export function SupportEmail({ midSentence = false }: { midSentence?: boolean }) {
  return (
    <s-link href={`mailto:${SUPPORT_EMAIL}`}>
      {midSentence ? "email" : "Email"} {SUPPORT_EMAIL}
    </s-link>
  );
}
