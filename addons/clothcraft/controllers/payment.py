from odoo.http import request, route

from odoo.addons.website_sale.controllers.payment import PaymentPortal


class ClothcraftPaymentPortal(PaymentPortal):

    @route('/shop/payment/transaction/<int:order_id>', type='jsonrpc', auth='public', website=True)
    def shop_payment_transaction(self, order_id, access_token, **kwargs):
        """Confirm cash-on-delivery and bank-transfer orders as soon as their transaction exists.

        Odoo confirms COD orders later, while the customer's browser polls the payment status, and
        leaves bank-transfer orders as quotations. A stock failure at that point would lose the
        customer's cart. Confirming here makes the stock check part of this request: if the last unit
        is gone the request fails with a clear message, no transaction is created and the cart stays.
        """
        processing_values = super().shop_payment_transaction(order_id, access_token, **kwargs)
        provider = request.env['payment.provider'].sudo().browse(int(kwargs['provider_id']))
        order_sudo = request.env['sale.order'].sudo().browse(order_id)
        if provider.code == 'custom' and order_sudo.state in ('draft', 'sent'):
            order_sudo.with_context(send_email=True).action_confirm()
        return processing_values
