import httpx

from .config import Settings


class OdooError(Exception):
    """Odoo did not answer, or refused. `status` is Odoo's HTTP status (0: no answer); `detail` its message."""

    def __init__(self, status: int, detail: str):
        super().__init__(f'Odoo {status}: {detail}')
        self.status = status
        self.detail = detail


class OdooClient:
    """Odoo's JSON-2 API (POST /json/2/<model>/<method>, bearer API key). The only way this service reaches Odoo."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(
            base_url=settings.odoo_url, transport=transport, timeout=settings.odoo_timeout_seconds,
            headers={'Authorization': f'Bearer {settings.odoo_api_key}', 'X-Odoo-Database': settings.odoo_db},
        )

    async def call(self, model: str, method: str, **kwargs):
        try:
            response = await self._client.post(f'/json/2/{model}/{method}', json=kwargs)
        except httpx.HTTPError as exc:
            raise OdooError(0, type(exc).__name__) from exc
        if response.status_code != 200:
            try:
                detail = response.json().get('message') or response.text[:200]
            except ValueError:
                detail = response.text[:200]
            raise OdooError(response.status_code, detail)
        return response.json()

    async def aclose(self):
        await self._client.aclose()


class ScopedOdoo:
    """The same client, with a session scope sent to Odoo on every call (`context.clothcraft_scope`): 'staff' or 'admin'. Odoo looks the session up in
    THAT scope only, so a session of the other kind is refused by Odoo itself. Used by the /api/admin mount of the employee routes (main.py)."""

    def __init__(self, client: OdooClient, scope: str):
        self._client = client
        self._scope = scope

    async def call(self, model: str, method: str, **kwargs):
        return await self._client.call(model, method, context={'clothcraft_scope': self._scope}, **kwargs)
