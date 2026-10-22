# Sheet Metal Manager (web)

Web system for the Sheet Metal Department: projects, parts and child parts, routing,
laser nesting, machines, tooling, plate stock, drawings, maintenance, NCR and workflow.
Everyone uses it from a browser (PC, tablet or phone) on the factory network; there is
nothing to install on each PC.

This is a website only: the server runs on one PC on the factory network and everyone
else opens it in a browser.

## Roles

| Role | Can do |
|---|---|
| Admin | Everything, including users, deletes and the activity log |
| Planner | View all; create and update projects, parts, routing and nesting; upload drawings; create workflow from routing; export. Cannot delete, and cannot change machines, tooling, plate stock, maintenance, NCR or workflow status |
| Viewer | View, open/download drawings and export only |

Each user also has a **process** (Designer, Planner, Engineer, Technician, Supervisor,
Operator, Manager). Everyone can read everything (to share information), but a user with a
process may only create and change the data that process owns (`OWNERS` in
`server/lib/resources.js`), e.g. Technician: machines, plate stock, maintenance, inventory;
Operator: own output; Manager: owns no shop data, approves Job Travellers. Daily log,
issues and the stock log are open to everyone.

Rules are enforced by the server (`server/lib/perm.js`), not only hidden in the screens.

**Security**: text that looks like HTML or script is refused, uploads are checked by their
content (PDF, STEP, DWG, DXF, PNG, JPG headers; programs and web pages are refused), SQL is
always parameterised, 5 wrong passwords lock a username for 15 minutes, and pages are sent
with a strict Content-Security-Policy. There is no feature that runs code from the website.

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
`PORT`, `HOST`, `DATA_DIR`, `SECURE_COOKIES=1` (when served over HTTPS), `COMPANY` (printed on
Job Travellers and NCRs) and `ADMIN_PASSWORD` (first start only).

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

- **Job Traveller**: one per part order (`JT-YYYY-0001`), with its process routing (Seq,
  process, cycle time, target). The Planner enters it on the website or uses **Import Excel**:
  the NEWAYS schedule reports and the combined dashboard (Fact_Production table) are read,
  shown as a preview, then saved. **Print / PDF** gives an A4 traveller with sign-off boxes.
- **Operator form**: one form for every shop process. Pick the process and Job Traveller,
  key in good, reject, run time, downtime, reject/downtime code and the process's own fields.
- **Shop processes** and **Reason codes** are data. Laser Cutting, Clinching, Bending and
  Polishing, and the Polishing codes DT-01…05 / RJ-01…05, are added on first start; Admin
  adds more (e.g. Welding) without code changes.
- **Daily board / Daily log / Issues**: daily work per job process (Designer → Operator),
  handovers, and problems raised from one process to another with a discussion.
- **Dashboard**: production by process (target, good, balance, completion, first-pass
  yield, remaining workload and the bottleneck process), KPIs, project progress, workflow
  board, machine load (465 net min/day),
  maintenance availability, MTBF and MTTR for the last 30 days, plates at or below minimum.
- **Projects**: open a project to plan parts (child parts shown under their parent),
  routing per part, laser nesting, drawings and NCRs.
- **Drawings**: drag and drop pdf, dwg, dxf, idw, slddrw, STEP (.step/.stp), ipt, iam,
  sldprt, sldasm, png or jpg, also from the Job Traveller page.
  The part number and revision are read from the file name (`606118901_PART_1 Rev C.pdf`);
  the older revision becomes Superseded. PDFs open in the browser; CAD files download.
- **Maintenance**: preventive, breakdown and inspection work orders with downtime.
- **NCR**: numbers `NCR-YYYY-0001` are given automatically; print or save as PDF (A4) with
  signature boxes.
- **Workflow**: "Create workflow" on a part builds the steps from its routing
  (Drawing review → Programming → operations → QC → Packing → Delivery).
- **Find Job Traveller**: the search box at the top of every page. The Job Traveller page shows
  where the item is now, each stage (Done / In progress / Pending with good and reject qty),
  mother and child parts, drawings and STEP files, and issues.
- **New project (parts)**: the Planner enters a mother part and its child parts (any depth,
  qty per parent), and can create a Job Traveller with routing for every part in one go.
- **Inventory** and **Stock log**: operator tools, maintenance spares and equipment with
  location, minimum stock and a Low / Out alert on the dashboard. Every use, check-out,
  return or receipt is logged by user, process, machine and maintenance work order.
- **Colour theme**: Standard, Light, Dark, Soft green or High contrast, under My account.
- **Excel templates**: Template / Import template / Export Excel on every list.
- **Export CSV** on every list (opens in Excel).
- **Publish** through Cloudflare Tunnel: see `deploy/cloudflare/README.md`.

## Development

```
npm test        # API and permission tests
```

Code layout: `server/` (Node.js HTTP server, built-in `node:sqlite`), `public/` (browser
app, plain JavaScript), `test/`. Modules are defined once in `server/lib/resources.js`;
the tables, API, forms and lists are built from those definitions.

## Open points

- Not built yet: DXF preview, PM plans with checklists and machine reading logs, BOM,
  NCR export to Excel.
