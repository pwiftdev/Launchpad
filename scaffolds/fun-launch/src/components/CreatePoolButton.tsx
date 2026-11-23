import Link from 'next/link';
import { cn } from '@/lib/utils';
import { buttonVariants } from './ui/button';

type CreatePoolButtonProps = {
  className?: string;
};

export const CreatePoolButton = ({ className }: CreatePoolButtonProps) => {
  return (
    <Link href="/launch" className={cn(buttonVariants({ variant: 'default' }), className)}>
      <span className="iconify ph--drop-bold h-4 w-4" />
      <span className="hidden sm:inline">Launch a coin</span>
      <span className="sm:hidden">Launch</span>
    </Link>
  );
};
