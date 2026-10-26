import base64
import random
from contextlib import contextmanager


def rng(seed, purpose):
    """A separate, stable random stream per purpose: changing one part never shifts another."""
    return random.Random(f"{seed}:{purpose}")


_recorders = []


def add_recorder(recorder):
    _recorders.append(recorder)


def remove_recorder(recorder):
    _recorders.remove(recorder)


@contextmanager
def at(when):
    """Run the block as if it were `when` (naive UTC datetime).

    Odoo reads the clock through fields.Datetime.now(), which this controls: order, receipt, move, quant and
    payment dates all follow. It cannot change create_date/write_date (those use the database clock), so
    recorders note when rows were written and `backfill` stamps them afterwards.
    """
    from freezegun import freeze_time  # imported here so the pure modules need no extra package
    with freeze_time(when):
        yield
    for recorder in _recorders:
        recorder.after(when)


def quiet(env):
    """No chatter, no tracking, no invitation emails: one message per record instead of five. No low-stock alerts or stock-edit history either."""
    return env(context=dict(
        env.context, tracking_disable=True, mail_notrack=True, mail_create_nolog=True,
        mail_auto_subscribe_no_notify=True, no_reset_password=True, clothcraft_no_alerts=True))


def read_image(assets_dir, relative_path):
    with open(f"{assets_dir.rstrip('/')}/{relative_path}", "rb") as handle:
        return base64.b64encode(handle.read())
