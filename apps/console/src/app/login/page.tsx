import { getOidcRuntime } from "../../lib/oidc";

const cell: React.CSSProperties = { padding: "4px 8px" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // the SSO button appears only when OIDC_CONFIG is mounted (ticket 034);
  // local accounts remain the break-glass path either way
  const sso = (await getOidcRuntime().catch(() => null)) !== null;
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
      {sso ? (
        <p>
          or <a href="/api/oidc/login">sign in with your organization (SSO)</a>
        </p>
      ) : null}
    </main>
  );
}
