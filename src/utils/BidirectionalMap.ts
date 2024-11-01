export class BidirectionalMap<T, U> {
    private forwardMap = new Map<T, U[]>();
    private reverseMap = new Map<U, T[]>();
    
    public set(key: T, values: U[]): void {
        const oldValues = this.forwardMap.get(key) || [];
        
        for (const oldValue of oldValues) {
            const keys = this.reverseMap.get(oldValue);
            if (keys) {
                const index = keys.indexOf(key);
                if (index !== -1) {
                    keys.splice(index, 1);
                    if (keys.length === 0) {
                        this.reverseMap.delete(oldValue);
                    }
                }
            }
        }
        
        if (values.length === 0) {
            this.forwardMap.delete(key);
        } else {
            this.forwardMap.set(key, values);
            for (const value of values) {
                if (!this.reverseMap.has(value)) {
                    this.reverseMap.set(value, []);
                }
                const keys = this.reverseMap.get(value)!;
                if (!keys.includes(key)) {
                    keys.push(key);
                }
            }
        }
    }

    public getForward(key: T): U[] | undefined {
        return this.forwardMap.get(key);
    }

    public getReverse(value: U): T[] | undefined {
        return this.reverseMap.get(value);
    }

    public deleteForward(key: T): void {
        const values = this.forwardMap.get(key);
        if (values) {
            for (const value of values) {
                const keys = this.reverseMap.get(value);
                if (keys) {
                    const index = keys.indexOf(key);
                    if (index !== -1) {
                        keys.splice(index, 1);
                        if (keys.length === 0) {
                            this.reverseMap.delete(value);
                        }
                    }
                }
            }
        }
        this.forwardMap.delete(key);
    }

    public deleteReverse(value: U): void {
        const keys = this.reverseMap.get(value);
        if (keys) {
            for (const key of keys) {
                const values = this.forwardMap.get(key);
                if (values) {
                    const index = values.indexOf(value);
                    if (index !== -1) {
                        values.splice(index, 1);
                        if (values.length === 0) {
                            this.forwardMap.delete(key);
                        }
                    }
                }
            }
        }
        this.reverseMap.delete(value);
    }

    public getForwardEntries(): [T, U[]][] {
        return Array.from(this.forwardMap.entries());
    }

    public getReverseEntries(): [U, T[]][] {
        return Array.from(this.reverseMap.entries());
    }
} 