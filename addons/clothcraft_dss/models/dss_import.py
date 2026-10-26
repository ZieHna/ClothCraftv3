"""Import of an engine bundle as a DSS run (B8 S3): a simulated run computed elsewhere (engine/bundle.py on clothcraft_sim2, through the
read-only role) shown in this database, labelled simulated.

Who: the Administrator (or server code / the Odoo shell). Where from: a folder directly under BUNDLE_ROOT inside the Odoo container,
mounted read-only (/mnt/dss-bundles). The path is resolved first, so a symlink or '..' cannot leave the folder.

Refused before anything is written (UserError, no run row):
  - import switched off (B8 S4a: IMPORT_SWITCH is not exactly '1'; the default, everywhere but clothcraft_demo);
  - a bundle of an older engine version (B8-S1 has no weekly actuals: regenerate it);
  - a path outside BUNDLE_ROOT, or a folder name with other than letters, digits, '.', '_' and '-';
  - no manifest.json, or a manifest version (its engine_version) that is not in KNOWN_VERSIONS;
  - a file list that is not exactly the bundle's tables plus summary.json, a listed file without a SHA-256, a missing or extra file, a
    file whose SHA-256 differs, or a bundle_sha256 that does not match the file hashes;
  - a bundle not marked simulated, unless this database is clothcraft_demo (DEMO_DB): there an unmarked bundle is accepted and still
    labelled simulated (demo data), everywhere else it is refused;
  - a duplicate: a run with the same output hash already exists (the second import is refused and names that run; nothing is written);
  - another DSS run in progress (the runner's advisory lock).
After that the run goes through the runner's guards in ONE transaction: created `running` (trigger import), the six output tables written
in a savepoint, finished `done`; an error while writing rolls the savepoint back (no output) and finishes the run `failed`.
Imported runs are always simulated = true. Customers are stored only as pseudonymous keys (a key that is not one already is replaced by
engine.bundle.pseudonym(source_db, key)); partner_key is always 0. Products and suppliers stay plain ids plus labels.
"""
import json
import os
import re

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError

from .dss_outputs import RUNNER
from .dss_run import ADMIN_GROUP, LOCK_KEY

BUNDLE_ROOT = '/mnt/dss-bundles'
DEMO_DB = 'clothcraft_demo'
KNOWN_VERSIONS = ('B8-S4',)
OLD_VERSIONS = ('B8-S1',)   # bundles without weekly actuals: refused, they must be regenerated
NAME_RE = re.compile(r'^[A-Za-z0-9._-]+$')
# B8 S4a: import is switched off unless this system parameter is exactly '1' (only clothcraft_demo turns it on). The parameter belongs to
# Settings > Technical (ir.config_parameter: base.group_system only); the ClothCraft Administrator role alone does not grant it.
IMPORT_SWITCH = 'clothcraft_dss.bundle_import_enabled'
IMPORT_BUTTON = 'action_import_bundle'


class ClothcraftDssRunImport(models.Model):
    _inherit = 'clothcraft.dss.run'

    # ------------------------------------------------------------------------------------------------------------ the switch
    @api.model
    def _import_enabled(self):
        return self.env['ir.config_parameter'].sudo().get_param(IMPORT_SWITCH) == '1'

    @api.model
    def _get_view_cache_key(self, view_id=None, view_type='form', **options):
        """Views are cached: the switch is part of the key, so turning it on or off shows or hides the button at once."""
        return super()._get_view_cache_key(view_id, view_type, **options) + (('dss_import', self._import_enabled()),)

    @api.model
    def _get_view(self, view_id=None, view_type='form', **options):
        """While import is switched off, the "Import simulated bundle" button is removed from the view."""
        arch, view = super()._get_view(view_id, view_type, **options)
        if not self._import_enabled():
            for node in arch.xpath(f"//button[@name='{IMPORT_BUTTON}']"):
                node.getparent().remove(node)
        return arch, view

    # ------------------------------------------------------------------------------------------------------------ checks
    def _import_check_enabled(self):
        if not self._import_enabled():
            raise UserError(self.env._("Bundle import is switched off on this database."))

    def _import_check_user(self):
        if not (self.env.su or self.env.user.has_group(ADMIN_GROUP)):
            raise AccessError(self.env._("Only an Administrator can import a DSS bundle."))

    @api.model
    def _import_resolve(self, path):
        """The bundle folder as a real path directly under BUNDLE_ROOT, or UserError."""
        root = os.path.realpath(BUNDLE_ROOT)
        real = os.path.realpath(str(path or ''))
        if os.path.dirname(real) != root or not NAME_RE.match(os.path.basename(real)):
            raise UserError(self.env._("A bundle must be a folder directly under %(root)s (letters, digits, '.', '_' and '-' only).", root=root))
        if not os.path.isdir(real):
            raise UserError(self.env._("No bundle folder at %(path)s.", path=real))
        return real

    @api.model
    def _import_read_manifest(self, folder):
        from ..engine import bundle
        mpath = os.path.join(folder, 'manifest.json')
        if not os.path.isfile(mpath):
            raise UserError(self.env._("The bundle has no manifest.json."))
        try:
            with open(mpath, encoding='utf-8') as fh:
                manifest = json.load(fh)
        except ValueError as exc:
            raise UserError(self.env._("The bundle's manifest.json cannot be read: %(error)s", error=exc))
        version = manifest.get('engine_version')
        if not version:
            raise UserError(self.env._("The bundle's manifest has no version (engine_version)."))
        if version in OLD_VERSIONS:
            raise UserError(self.env._("This bundle was written by engine %(version)s, which has no weekly actuals; regenerate it with the "
                                       "current engine (%(known)s).", version=version, known=', '.join(KNOWN_VERSIONS)))
        if version not in KNOWN_VERSIONS:
            raise UserError(self.env._("Unknown bundle version %(version)s (known: %(known)s).", version=version, known=', '.join(KNOWN_VERSIONS)))
        files = manifest.get('files') or {}
        expected = {f'{name}.csv.gz' for name in bundle.TABLES} | {'summary.json'}
        if set(files) != expected:
            raise UserError(self.env._("The bundle's file list is not the expected one (missing: %(missing)s; unexpected: %(extra)s).",
                                       missing=', '.join(sorted(expected - set(files))) or '-', extra=', '.join(sorted(set(files) - expected)) or '-'))
        missing_sha = sorted(n for n, f in files.items() if not isinstance(f, dict) or not re.fullmatch(r'[0-9a-f]{64}', str(f.get('sha256', ''))))
        if missing_sha or not re.fullmatch(r'[0-9a-f]{64}', str(manifest.get('bundle_sha256', ''))):
            raise UserError(self.env._("The bundle has a missing or malformed checksum (%(files)s).", files=', '.join(missing_sha) or 'bundle_sha256'))
        on_disk = set(os.listdir(folder)) - {'manifest.json'}
        if on_disk != expected:
            raise UserError(self.env._("The bundle folder does not hold exactly its listed files (missing: %(missing)s; unexpected: %(extra)s).",
                                       missing=', '.join(sorted(expected - on_disk)) or '-', extra=', '.join(sorted(on_disk - expected)) or '-'))
        ok, problems = bundle.verify_bundle(folder)
        if not ok:
            raise UserError(self.env._("The bundle failed its checksums: %(problems)s.", problems='; '.join(problems)))
        if not manifest.get('simulated') and self.env.cr.dbname != DEMO_DB:
            raise UserError(self.env._("This bundle is not marked simulated; only %(demo)s accepts such a bundle.", demo=DEMO_DB))
        return manifest

    @api.model
    def _import_load(self, folder, manifest):
        """The bundle as the runner's result: {'meta', 'tables', 'summary'}, customers pseudonymised."""
        import pandas as pd
        from ..engine import bundle
        tables = {name: pd.read_csv(os.path.join(folder, f'{name}.csv.gz')) for name in bundle.TABLES
                  if manifest['files'][f'{name}.csv.gz']['rows']}
        for name in bundle.TABLES:
            tables.setdefault(name, pd.DataFrame())
        seg = tables['segments']
        if len(seg):
            seg = seg.copy()
            src = manifest.get('source_db') or 'unknown'
            seg['customer_key'] = [k if isinstance(k, str) and k.startswith('c_') else bundle.pseudonym(src, int(float(k)))
                                   for k in seg['customer_key']]
            seg['partner_id'] = None
            tables['segments'] = seg
        with open(os.path.join(folder, 'summary.json'), encoding='utf-8') as fh:
            summary = json.load(fh)
        meta = {k: v for k, v in manifest.items() if k not in ('files', 'bundle_sha256')}
        meta['simulated'] = True
        meta['label'] = manifest.get('label') or bundle.SIMULATED_LABEL
        return {'meta': meta, 'tables': tables, 'summary': summary}

    # ------------------------------------------------------------------------------------------------------------ the import
    @api.model
    def _import_bundle(self, path):
        """Import the bundle folder at `path` (see the module docstring). Returns the run (done, or failed while writing)."""
        self._import_check_user()
        self._import_check_enabled()
        folder = self._import_resolve(path)
        manifest = self._import_read_manifest(folder)
        result = self._import_load(folder, manifest)
        output_hash = self._dss_output_hash(result)
        cr = self.env.cr
        cr.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))', [LOCK_KEY])
        if not cr.fetchone()[0]:
            raise UserError(self.env._("A DSS run is in progress; import the bundle when it has finished."))
        dup = self.sudo().search([('output_hash', '=', output_hash)], limit=1)
        if dup:
            raise UserError(self.env._("This bundle is already imported as %(run)s (same output hash); nothing was imported.",
                                       run=dup.display_name))
        runner = self.sudo().with_context(**{RUNNER: True})
        run = runner.create({'trigger': 'import', 'requested_by_uid': self.env.uid, 'requested_by_name': self.env.user.name,
                             'company_id': self.env.company.id, 'started_at': fields.Datetime.now()})
        try:
            with cr.savepoint():
                counts = run._dss_write_outputs(result)
                run.write({**run._dss_meta(result), 'simulated': True, 'row_counts': counts, 'output_hash': output_hash,
                           'bundle_sha256': manifest['bundle_sha256'], 'state': 'done', 'finished_at': fields.Datetime.now(), 'duration_s': 0.0})
                self.env.flush_all()
        except Exception as exc:  # the savepoint is rolled back: no output row of this run remains
            self.env.invalidate_all()
            run.write({'state': 'failed', 'error': f'Import failed: {type(exc).__name__}: {exc}'[:2000], 'finished_at': fields.Datetime.now(),
                       'bundle_sha256': manifest['bundle_sha256']})
        return run

    def action_import_bundle(self):
        """The Administrator's button in the DSS runs list: opens the import form."""
        self._import_check_user()
        self._import_check_enabled()
        return {'type': 'ir.actions.act_window', 'res_model': 'clothcraft.dss.import.wizard', 'view_mode': 'form', 'target': 'new',
                'name': self.env._("Import a simulated bundle")}


class ClothcraftDssImportWizard(models.TransientModel):
    _name = 'clothcraft.dss.import.wizard'
    _description = 'Import a DSS bundle'

    path = fields.Char(required=True, default=lambda self: BUNDLE_ROOT + '/',
                       help="A bundle folder directly under %s inside the Odoo container (mounted read-only)." % BUNDLE_ROOT)

    def action_import(self):
        self.ensure_one()
        run = self.env['clothcraft.dss.run']._import_bundle(self.path)
        return {'type': 'ir.actions.act_window', 'res_model': 'clothcraft.dss.run', 'res_id': run.id, 'view_mode': 'form', 'target': 'current'}
