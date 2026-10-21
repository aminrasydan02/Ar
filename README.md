# Sheet Metal Manager (web)

Web system for the Sheet Metal Department: projects, parts and child parts, routing,
laser nesting, machines, tooling, plate stock, drawings, maintenance, NCR and workflow.
Everyone uses it from a browser (PC, tablet or phone) on the factory network; there is
nothing to install on each PC.

Version 2.0.0 is the web edition of the Sheet Metal Manager 1.4.0 Windows app.

## Roles

| Role | Can do |
|---|---|
| Admin | Everything, including users, deletes and the activity log |
| Planner | View all; create and update projects, parts, routing and nesting; upload drawings; create workflow from routing; export. Cannot delete, and cannot change machines, tooling, plate stock, maintenance, NCR or workflow status |
| Viewer | View, open/download drawings and export only |

Rules are enforced by the server (`server/lib/perm.js`), not only hidden in the screens.

## Install on the department server

Needs **Node.js 22.13 or newer** (https://nodejs.org). There are no other packages to install.

```
git clone https://github.com/aminrasydan02/Ar.git sheet-metal-manager
cd sheet-metal-manager
npm start
```

On first start the console prints the password for the `admin` account. Sign in at
`http://<server-name>:8080`, then change the password under **My account** and add users
under **Users**.

To load the NEWAYS demo project (6 parts, 1,339 pcs, 4 machines, 8 nesting programs):

```
npm run seed-demo
```

Settings: copy `config.example.json` to `config.json`, or use environment variables
`PORT`, `HOST`, `DATA_DIR`, `SECURE_COOKIES=1` (when served over HTTPS) and `ADMIN_PASSWORD`
(first start only).

Forgotten admin password:

```
node server/server.js reset-password admin <new password>
```

To keep it running on Windows Server, use Task Scheduler ("At startup", run `npm start`
in this folder) or a service wrapper such as NSSM.

## Backup

Everything lives in the `data` folder: `smm.sqlite` (database) and `drawings/` (uploaded
files). Back up the whole folder. For a consistent copy, stop the server first or copy
during a quiet period.

## Modules

- **Dashboard**: KPIs, project progress, workflow board, machine load (480 min/day),
  maintenance availability, MTBF and MTTR for the last 30 days, plates at or below minimum.
- **Projects**: open a project to plan parts (child parts shown under their parent),
  routing per part, laser nesting, drawings and NCRs.
- **Drawings**: drag and drop pdf, dwg, idw, slddrw, ipt, iam, sldprt, sldasm or dxf.
  The part number and revision are read from the file name (`606118901_PART_1 Rev C.pdf`);
  the older revision becomes Superseded. PDFs open in the browser; CAD files download.
- **Maintenance**: preventive, breakdown and inspection work orders with downtime.
- **NCR**: numbers `NCR-YYYY-0001` are given automatically; print or save as PDF (A4) with
  signature boxes.
- **Workflow**: "Create workflow" on a part builds the steps from its routing
  (Drawing review → Programming → operations → QC → Packing → Delivery).
- **Export CSV** on every list (opens in Excel).

## Development

```
npm test        # API and permission tests
```

Code layout: `server/` (Node.js HTTP server, built-in `node:sqlite`), `public/` (browser
app, plain JavaScript), `test/`. Modules are defined once in `server/lib/resources.js`;
the tables, API, forms and lists are built from those definitions.

## Open points

- Clinching cycle time: the NEWAYS report says 2.92 min, but 5 × 20 s + 15 s = 1.92 min.
  Confirm before entering routing times.
- Not yet carried over from 1.4.0: Excel import, DXF preview, PM plans with checklists and
  machine reading logs, NCR export to Excel, online update for the desktop app.
