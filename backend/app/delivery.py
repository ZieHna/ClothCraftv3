"""What a delivery address must look like. A port of frontend/src/lib/deliveryRules.ts: the sentences are the same, and
contract/delivery-validation.json is run against both so they cannot drift."""
import re

EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')
PH_MOBILE = re.compile(r'^(09\d{9}|\+639\d{9})$')
PH_POSTAL = re.compile(r'^\d{4}$')
FIELDS = ['fullName', 'email', 'phone', 'street', 'city', 'province', 'postalCode', 'note']


def validate_delivery(d: dict, province_codes: list[str]) -> dict[str, str]:
    errors: dict[str, str] = {}
    name = d['fullName'].strip()
    if len(name) < 2:
        errors['fullName'] = 'Enter your full name.'
    elif len(name) > 80:
        errors['fullName'] = 'Use 80 characters or fewer for the name.'
    if not EMAIL.match(d['email'].strip()):
        errors['email'] = 'Enter an email address like name@example.com.'
    if not PH_MOBILE.match(re.sub(r'[\s-]', '', d['phone'])):
        errors['phone'] = 'Enter a Philippine mobile number, like 0917 123 4567 or +63 917 123 4567.'
    if len(d['street'].strip()) < 5:
        errors['street'] = 'Enter your house number and street, at least 5 characters.'
    if len(d['city'].strip()) < 2:
        errors['city'] = 'Enter your city or municipality.'
    if d['province'] not in province_codes:
        errors['province'] = 'Choose your province.'
    if not PH_POSTAL.match(d['postalCode'].strip()):
        errors['postalCode'] = 'Enter a 4-digit postal code, like 1000.'
    if len(d['note']) > 300:
        errors['note'] = 'Keep the delivery note to 300 characters or fewer.'
    return errors


def is_complete(value) -> bool:
    """Every field present and a string, so validate_delivery cannot raise."""
    return isinstance(value, dict) and all(isinstance(value.get(f), str) for f in FIELDS)
