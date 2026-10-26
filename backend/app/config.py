from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the environment, and from backend/.env when present (gitignored; the API key lives only there)."""
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    odoo_url: str = 'http://odoo:8069'
    odoo_db: str = 'clothcraft_dev'
    odoo_api_key: str = ''
    odoo_timeout_seconds: float = 20.0
    # Customer sessions (step 6d). The cookie holds a random session id and an HMAC of it made with this secret (32+ characters,
    # only in the gitignored .env). Changing the secret ends every session.
    session_secret: str = ''
    # Origins the browser may send on a state-changing request, comma separated (for example http://localhost:5173). Empty: none.
    allowed_origins: str = ''
    # Addresses whose X-Forwarded-For / X-Forwarded-Proto are believed, comma separated; '*' trusts anyone (tests and development only).
    trusted_proxies: str = ''
    # None: the cookie is Secure when the request came over https. True or False forces it.
    cookie_secure: bool | None = None
    max_auth_body_bytes: int = 16384
    # a design upload (step 9b): Odoo allows 20 MB decoded in all (models/design.py LIMITS); as base64 that is 26.7 MB, plus the JSON
    # around it. Anything larger is refused while it streams in, before it is read whole or sent on.
    max_design_body_bytes: int = 28 * 1024 * 1024
    # a whole cart (step 12): at most 50 lines of a few dozen bytes each; 32 KB leaves room and refuses anything else early
    max_cart_body_bytes: int = 32 * 1024
    # the shop's own rules (not stored in Odoo): see contract/README.md
    low_stock_at: int = 2
    max_line_quantity: int = 99
    max_cart_lines: int = 50
    # what the shop says about delivery and where a bank transfer goes: settings (backend/.env: DELIVERY_LABEL, BANK_NAME,
    # BANK_ACCOUNT_NAME, BANK_ACCOUNT_NUMBER). Delivery rates are not decided yet, so it is free; the bank details stay placeholders,
    # with the page's "do not send money" warning, until the shop has a real account.
    delivery_label: str = 'Free delivery'
    bank_name: str = 'Sample Bank (placeholder)'
    bank_account_name: str = 'ClothCraft (placeholder)'
    bank_account_number: str = '0000 0000 0000 (placeholder)'


settings = Settings()
