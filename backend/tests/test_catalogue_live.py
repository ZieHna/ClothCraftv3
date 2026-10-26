"""Step 8b against the REAL service and Odoo: the catalogue's storefront facts come from Odoo fields, and the product picture is Odoo's own,
served by the service. Skipped unless CONTRACT_BASE_URL is set. Read-only: it changes nothing in the database, so it may also run against
the dev stack. (The contract cases cannot carry it: their runners read every answer as JSON, and a picture is not.)
"""
import os
import re

import httpx
import pytest

BASE = os.environ.get('CONTRACT_BASE_URL')
pytestmark = pytest.mark.skipif(not BASE, reason='CONTRACT_BASE_URL is not set')


@pytest.fixture(scope='module')
def http():
    with httpx.Client(base_url=BASE, timeout=60) as client:
        yield client


@pytest.fixture(scope='module')
def products(http):
    return http.get('/api/catalogue/products').json()['data']['products']


def test_every_product_has_its_storefront_id_group_and_a_versioned_picture_address(products):
    assert products
    for p in products:
        assert re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', p['id']), p['id']
        assert p['group'] in ('Men', 'Women', 'Kids', 'Babies')
        assert re.fullmatch(rf'/api/catalogue/products/{p["id"]}/image(\?v=[0-9a-f]{{12}})?', p['image']), p['image']


def test_the_picture_is_served_with_a_version_tag_and_a_day_of_caching_and_304_when_unchanged(http, products):
    first = products[0]
    response = http.get(first['image'])
    assert response.status_code == 200
    assert response.headers['content-type'].startswith('image/')
    assert len(response.content) > 1000
    assert response.headers['cache-control'] == 'public, max-age=86400'
    assert response.headers['x-content-type-options'] == 'nosniff'
    etag = response.headers['etag']
    again = http.get(first['image'], headers={'If-None-Match': etag})
    assert again.status_code == 304


def test_an_unknown_product_or_a_bad_id_has_no_picture(http):
    for path in ('/api/catalogue/products/no-such-product/image', '/api/catalogue/products/NOT_AN_ID/image'):
        response = http.get(path)
        assert response.status_code == 404 and response.json()['error']['code'] == 'not_found'


def test_featured_is_a_subset_of_the_catalogue_and_never_sold_out(http, products):
    featured = http.get('/api/catalogue/featured').json()['data']['products']
    by_id = {p['id']: p for p in products}
    assert all(f['id'] in by_id and f['status'] != 'out_of_stock' for f in featured)
    assert 'featured' not in (featured[0] if featured else {})   # the flag itself is not part of the API's shape
