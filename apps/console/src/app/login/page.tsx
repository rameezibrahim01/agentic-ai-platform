const cell: React.CSSProperties = { padding: "4px 8px" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>sign in</h2>
      {error ? <p style={{ color: "#a00" }}>invalid username or password</p> : null}
      <form action="/api/login" method="post">
        <table>
          <tbody>
            <tr>
              <td style={cell}>
                <label htmlFor="username">username</label>
              </td>
              <td style={cell}>
                <input id="username" name="username" autoComplete="username" required />
              </td>
            </tr>
            <tr>
              <td style={cell}>
                <label htmlFor="password">password</label>
              </td>
              <td style={cell}>
                <input id="password" name="password" type="password" autoComplete="current-password" required />
              </td>
            </tr>
            <tr>
              <td style={cell} />
              <td style={cell}>
                <button type="submit">sign in</button>
              </td>
            </tr>
          </tbody>
        </table>
      </form>
    </main>
  );
}
