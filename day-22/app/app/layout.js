import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "Week 1 dApp — Day 22",
  description: "To-do list and piggy bank on a local chain, with wallet connect",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
