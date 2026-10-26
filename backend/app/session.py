"""The session cookie, the client address and the origin check. Standard library only.

A session is a random id the browser holds; Odoo keeps only the SHA-256 of it (clothcraft.api.session), so a copy of Odoo's table is
not a set of working cookies. The cookie also carries an HMAC of the id made with SESSION_SECRET: a forged or tampered cookie is
turned away here, before any call to Odoo. What makes sign-out and expiry real is Odoo's row, not the cookie.
"""
import hashlib
import hmac
import secrets

from fastapi import Request

from .config import Settings

COOKIE = 'cc_session'
SECURE_COOKIE = '__Host-cc_session'   # the __Host- prefix needs Secure and Path=/, so it is used only over https
STAFF_COOKIE = 'cc_staff'            # the staff dashboard's own session: a different cookie, a different MAC, a different server-side scope
STAFF_SECURE_COOKIE = '__Host-cc_staff'
ADMIN_COOKIE = 'cc_admin'            # the Administrator's own sign-in (/admin): a third cookie, its own MAC, its own server-side scope
ADMIN_SECURE_COOKIE = '__Host-cc_admin'


def cookie_names(kind: str = 'customer') -> tuple[str, str]:
    """(plain name, __Host- name) of the cookie of this kind."""
    if kind == 'admin':
        return ADMIN_COOKIE, ADMIN_SECURE_COOKIE
    return (STAFF_COOKIE, STAFF_SECURE_COOKIE) if kind == 'staff' else (COOKIE, SECURE_COOKIE)
STATE_CHANGING = {'POST', 'PUT', 'PATCH', 'DELETE'}


def new_sid() -> str:
    return secrets.token_urlsafe(32)


def sid_hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def _mac(sid: str, secret: str, kind: str = 'customer') -> str:
    # the kind is part of what is signed: a customer cookie's MAC is not a valid staff MAC even for the same id, and the reverse
    message = sid if kind == 'customer' else f'{kind}:{sid}'
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def cookie_value(sid: str, secret: str, kind: str = 'customer') -> str:
    return f'{sid}.{_mac(sid, secret, kind)}'


def parse_cookie(value: str | None, secret: str, kind: str = 'customer') -> str | None:
    """The session id inside a cookie value, or None for anything missing, malformed, forged or tampered with."""
    if not value or len(value) > 200 or value.count('.') != 1:
        return None
    sid, mac = value.split('.')
    if not sid or not hmac.compare_digest(mac, _mac(sid, secret, kind)):
        return None
    return sid


def _csv(text: str) -> list[str]:
    return [part.strip() for part in text.split(',') if part.strip()]


def from_trusted_proxy(request: Request, settings: Settings) -> bool:
    trusted = _csv(settings.trusted_proxies)
    return '*' in trusted or (request.client is not None and request.client.host in trusted)


def client_ip(request: Request, settings: Settings) -> str:
    """The address the attempt counters use. X-Forwarded-For is believed only when it comes from a proxy we trust (the first entry:
    the original client). Behind Docker's port mapping every client looks like the gateway, so in development this is weak and the
    per-email counter is the real defence."""
    forwarded = request.headers.get('x-forwarded-for')
    if forwarded and from_trusted_proxy(request, settings):
        return forwarded.split(',')[0].strip()[:64]
    return request.client.host if request.client else '-'


def is_https(request: Request, settings: Settings) -> bool:
    if settings.cookie_secure is not None:
        return settings.cookie_secure
    if request.url.scheme == 'https':
        return True
    return request.headers.get('x-forwarded-proto') == 'https' and from_trusted_proxy(request, settings)


def sid_from_request(request: Request, settings: Settings, kind: str = 'customer') -> str | None:
    plain, secure = cookie_names(kind)
    for name in (secure, plain):
        sid = parse_cookie(request.cookies.get(name), settings.session_secret, kind)
        if sid:
            return sid
    return None


def origin_allowed(request: Request, settings: Settings) -> bool:
    """A state-changing request is refused when a browser says it came from another site. Requests with no Origin (curl, the
    service's own tests) are not browsers acting for someone, so they pass; a browser always sends Origin on a cross-site POST."""
    if request.headers.get('sec-fetch-site') == 'cross-site':
        return False
    origin = request.headers.get('origin')
    return origin is None or origin in _csv(settings.allowed_origins)
