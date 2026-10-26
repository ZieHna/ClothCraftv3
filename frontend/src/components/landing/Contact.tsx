import { TornEdge } from './TornEdge';

// The shop's address is not decided yet, so it is not invented: set VITE_CONTACT_EMAIL (.env) and it appears here.
const EMAIL = import.meta.env.VITE_CONTACT_EMAIL?.trim();

/** Plain on purpose: an email link or a short note. No form, no third-party service. */
export function Contact() {
  return (
    <section id="contact" aria-labelledby="contact-title" className="relative bg-paper-warm">
      <TornEdge className="fill-paper-warm" />
      <div className="mx-auto max-w-6xl px-4 py-16 lg:py-20">
        <p className="eyebrow">Contact</p>
        <h2 id="contact-title" className="mt-2 text-5xl leading-none sm:text-6xl">
          Questions? <em className="text-brown">Ask.</em>
        </h2>
        {EMAIL ? (
          <p className="mt-5 max-w-prose text-lg">
            Write to us at{' '}
            <a href={`mailto:${EMAIL}`} className="font-semibold text-sage-dark underline underline-offset-4">
              {EMAIL}
            </a>
            .
          </p>
        ) : (
          <p className="mt-5 max-w-prose text-lg">Contact details will be published here before launch.</p>
        )}
      </div>
    </section>
  );
}
