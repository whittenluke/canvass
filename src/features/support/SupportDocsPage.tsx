type SupportDocsPageProps = {
  audience: 'admins' | 'canvassers'
}

function SupportHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="support-docs-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  )
}

function SupportSection({
  title,
  paragraphs,
}: {
  title: string
  paragraphs: string[]
}) {
  return (
    <section className="support-docs-section">
      <h2>{title}</h2>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  )
}

export function SupportDocsPage({ audience }: SupportDocsPageProps) {
  const isAdmin = audience === 'admins'
  const title = isAdmin ? 'Admin Guide' : 'Canvasser Guide'
  const subtitle = isAdmin
    ? 'How admins use Canvass day to day.'
    : 'How canvassers use Canvass in assigned areas.'

  const sections = isAdmin
    ? [
        {
          title: 'What admins can do',
          paragraphs: [
            'Admins can view the full map, create and manage areas, assign areas to users, and track progress. Admins can also mark individual addresses canvassed or uncanvassed, and can mark an entire area canvassed or uncanvassed when needed.',
          ],
        },
        {
          title: 'Signing in',
          paragraphs: [
            'Open Canvass and sign in using the email link sent to you. After signing in, you will land on the main map view.',
          ],
        },
        {
          title: 'Understanding the admin map',
          paragraphs: [
            'The admin map shows all created areas. Each area has a label and can be selected either from the map or from the side panel.',
            'When no area is selected, address dots can be shown across the full map.',
            'When an area is selected, the map centers on that area. If dots are turned on, only the dots in that area are shown.',
          ],
        },
        {
          title: 'Creating an area',
          paragraphs: [
            'Use the map tools to draw a new area around the neighborhood or section you want to assign. After drawing it, save it and give it a clear name.',
            'Area names should describe the place or section, not just the person working it, whenever possible.',
          ],
        },
        {
          title: 'Renaming an area',
          paragraphs: [
            'Select the area from the map or side panel. Update the area name in the details panel and save your change.',
          ],
        },
        {
          title: 'Assigning an area',
          paragraphs: [
            'Select an area, then assign it to a user by entering or selecting their email. Once assigned, that user will see the area after signing in.',
            'You can reassign an area later if needed.',
          ],
        },
        {
          title: 'Viewing progress',
          paragraphs: [
            'Select an area to view its progress. Progress is shown as a number and percentage based on how many addresses in that area have been marked canvassed.',
          ],
        },
        {
          title: 'Marking addresses',
          paragraphs: [
            'Admins can mark individual addresses canvassed by clicking an address dot and using the action button.',
            'Admins can also mark an address uncanvassed if a correction is needed.',
          ],
        },
        {
          title: 'Marking an entire area',
          paragraphs: [
            'If needed, admins can mark a full area canvassed or uncanvassed from the area controls.',
            'Use this carefully, since it affects all addresses in the selected area.',
          ],
        },
        {
          title: 'Best practices for admins',
          paragraphs: [
            'Create areas before canvassing starts so assignments are clear.',
            'Use clear area names so reassignment is easy later.',
            'Check progress by area instead of relying on memory or text updates.',
            'Use whole-area actions only when you are sure the area should be updated in bulk.',
          ],
        },
      ]
    : [
        {
          title: 'What canvassers can do',
          paragraphs: [
            'Canvassers can sign in, view only the areas assigned to them, see progress for each assigned area, and mark addresses canvassed from either the map or the address list.',
          ],
        },
        {
          title: 'Signing in',
          paragraphs: [
            'Open Canvass and sign in using the email link sent to you. After signing in, you will see only the areas assigned to you.',
          ],
        },
        {
          title: 'Viewing your areas',
          paragraphs: [
            'Your assigned areas appear in a list. Click an area to open it and view its progress.',
          ],
        },
        {
          title: 'Using the map',
          paragraphs: [
            'When you open an assigned area, you can view the addresses on the map and mark them as canvassed.',
            'Tap an address dot, then use the button to mark it canvassed.',
            'If a correction is needed, you can mark it uncanvassed.',
          ],
        },
        {
          title: 'Using address view',
          paragraphs: [
            'You can also switch to Address mode. In this view, addresses are grouped by street.',
            'Open a street section to see the addresses in that group. Use the button next to an address to mark it canvassed.',
            'This view is useful when map dots are close together or when you want to work through a street in order.',
          ],
        },
        {
          title: 'Progress',
          paragraphs: [
            'Each assigned area shows progress so you can quickly see how much of the area has been completed.',
          ],
        },
        {
          title: 'Important limits',
          paragraphs: [
            'Canvassers only see areas assigned to them.',
            'Canvassers cannot work outside their assigned areas.',
          ],
        },
        {
          title: 'Best practices for canvassers',
          paragraphs: [
            'Start by opening the area you are assigned to.',
            'Use the map for location awareness and the address list when you want a faster way to work through streets.',
            'Mark addresses as you go so progress stays accurate.',
            'If you are unsure which area to work, contact the admin before starting.',
          ],
        },
      ]

  return (
    <main className="support-docs-shell">
      <div className="support-docs-card">
        <SupportHeader title={title} subtitle={subtitle} />
        <nav className="support-docs-nav" aria-label="Support pages">
          <a
            className={isAdmin ? 'support-docs-link active' : 'support-docs-link'}
            href="/support/admins"
          >
            For Admins
          </a>
          <a
            className={!isAdmin ? 'support-docs-link active' : 'support-docs-link'}
            href="/support/canvassers"
          >
            For Canvassers
          </a>
        </nav>
        <article className="support-docs-content">
          {sections.map((section) => (
            <SupportSection
              key={section.title}
              title={section.title}
              paragraphs={section.paragraphs}
            />
          ))}
        </article>
      </div>
    </main>
  )
}
