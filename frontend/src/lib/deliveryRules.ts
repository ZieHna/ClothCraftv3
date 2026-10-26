import type { DeliveryDetails } from '../api/types';

/**
 * What a delivery address must look like. The checkout form uses this to tell the shopper early; the SERVER checks the same
 * things again (a browser can be bypassed), and its 422 answer is shown the same way. The mock server imports this file so the
 * two cannot drift while there is no real server. Messages are sentences, never just a colour.
 */
export type DeliveryField = keyof DeliveryDetails;
export type DeliveryErrors = Partial<Record<DeliveryField, string>>;

/** The order the fields appear in the form, so the error summary lists them top to bottom. */
export const DELIVERY_FIELDS: DeliveryField[] = ['fullName', 'email', 'phone', 'street', 'city', 'province', 'postalCode', 'note'];

export const EMPTY_DELIVERY: DeliveryDetails = { fullName: '', email: '', phone: '', street: '', city: '', province: '', postalCode: '', note: '' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PH_MOBILE = /^(09\d{9}|\+639\d{9})$/;
const PH_POSTAL = /^\d{4}$/;

export function validateDelivery(d: DeliveryDetails, provinceCodes: readonly string[]): DeliveryErrors {
  const errors: DeliveryErrors = {};
  const name = d.fullName.trim();
  if (name.length < 2) errors.fullName = 'Enter your full name.';
  else if (name.length > 80) errors.fullName = 'Use 80 characters or fewer for the name.';
  if (!EMAIL.test(d.email.trim())) errors.email = 'Enter an email address like name@example.com.';
  if (!PH_MOBILE.test(d.phone.replace(/[\s-]/g, ''))) errors.phone = 'Enter a Philippine mobile number, like 0917 123 4567 or +63 917 123 4567.';
  if (d.street.trim().length < 5) errors.street = 'Enter your house number and street, at least 5 characters.';
  if (d.city.trim().length < 2) errors.city = 'Enter your city or municipality.';
  if (!provinceCodes.includes(d.province)) errors.province = 'Choose your province.';
  if (!PH_POSTAL.test(d.postalCode.trim())) errors.postalCode = 'Enter a 4-digit postal code, like 1000.';
  if (d.note.length > 300) errors.note = 'Keep the delivery note to 300 characters or fewer.';
  return errors;
}
