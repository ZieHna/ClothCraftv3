import { Contact } from '../components/landing/Contact';
import { DesignCta } from '../components/landing/DesignCta';
import { FeaturedDesigns } from '../components/landing/FeaturedDesigns';
import { Hero } from '../components/landing/Hero';
import { HowItWorks } from '../components/landing/HowItWorks';
import { ShopByCategory } from '../components/landing/ShopByCategory';

/** Sections in the order of the original ClothCraft landing page. The header and footer come from Layout. */
export function Landing() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <ShopByCategory />
      <FeaturedDesigns />
      <DesignCta />
      <Contact />
    </>
  );
}
