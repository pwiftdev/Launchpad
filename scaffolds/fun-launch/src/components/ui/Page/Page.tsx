import { AppShell } from '@/components/shell/AppShell';
import { cn } from '@/lib/utils';

interface IProps {
  containerClassName?: string;
  /** Board-style layout: fills the viewport, panels scroll on their own */
  app?: boolean;
}

const Page: React.FC<React.PropsWithChildren<IProps>> = ({ containerClassName, children, app }) => (
  <AppShell fill={app}>
    {app ? (
      children
    ) : (
      <div
        className={cn(
          'enter mx-auto w-full max-w-6xl px-4 pb-16 pt-6 md:px-6 md:pt-8',
          containerClassName
        )}
      >
        {children}
      </div>
    )}
  </AppShell>
);

export default Page;
